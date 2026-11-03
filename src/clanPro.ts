import type { Room } from "colyseus";
import { db, dzDay, maybe, parseDate, pbDate, pushToUsers, settings, signedIn } from "./accounts.js";
import { CLAN_PACKS, CLAN_SLOTS, clanPriceOf, slotOf } from "./clanItems.js";
import { CLAN_SENDER, ClanError, forClan, memberOf, may, myMembership } from "./clans.js";
import { hasBadWord } from "./plans.js";

/**
 * The Pro clan: a clan whose leader or sponsor (a member with VIP Pro) has VIP Pro. When neither has it any more, 7 days'
 * notice, then Pro pauses: what it owns stays, and comes back with Pro. Pro opens the clan store (the leader buys from the
 * clan's wallet), a second pinned line, a daily announcement, polls, a calendar and members-only rooms.
 */
export const PRO_NOTICE_MS = 7 * 86_400_000;

type Line = { clan: string; user: string; kind: string; text?: string; data?: unknown };
const line = async (l: Line) => (await db()).collection("clan_messages").create(l);

const leaderOf = async (clan: string) => {
  const client = await db();
  const { items } = await client.collection("clan_members").getList(1, 1, { filter: client.filter('clan = {:clan} && role = "leader"', { clan }), fields: "user" });
  return String(items[0]?.user ?? "");
};

/** Reads a clan's leader and sponsor, and starts, warns about or ends its Pro. [quiet]: no line in its chat, no push. */
export async function refreshPro(clanId: string, quiet = false) {
  const client = await db();
  const clan = await maybe(client.collection("clans").getOne(clanId, { fields: "id,pro,proEnds,sponsor,name,tag" }));
  if (!clan) return;
  const leader = await leaderOf(clanId);
  const ids = [...new Set([leader, String(clan.sponsor ?? "")])].filter(Boolean);
  const params = Object.fromEntries(ids.map((id, i) => [`u${i}`, id]));
  const filter = ids.map((_, i) => `id = {:u${i}}`).join(" || ");
  const has = ids.length > 0 && (await client.collection("users").getList(1, 1, { filter: client.filter(`vipPro = true && (${filter})`, params), fields: "id", skipTotal: true })).items.length > 0;
  if (has) {
    if (clan.pro === true && !clan.proEnds) return;
    await client.collection("clans").update(clanId, { pro: true, proEnds: "" });
    if (clan.pro !== true && leader && !quiet) await line({ clan: clanId, user: leader, kind: "pro", data: { state: "on" } });
    return;
  }
  if (clan.pro !== true) return;
  if (!clan.proEnds) {
    await client.collection("clans").update(clanId, { proEnds: pbDate(Date.now() + PRO_NOTICE_MS) });
    if (quiet) return;
    if (leader) await line({ clan: clanId, user: leader, kind: "pro", data: { state: "ending" } });
    void pushToUsers(ids, { sender: CLAN_SENDER, title: `[${clan.tag}] ${clan.name}`, body: "⏳ PRO: 7" }).catch(() => {});
    return;
  }
  if (parseDate(clan.proEnds) <= Date.now()) {
    await client.collection("clans").update(clanId, { pro: false, proEnds: "" });
    if (leader && !quiet) await line({ clan: clanId, user: leader, kind: "pro", data: { state: "off" } });
  }
}

/** [uid]'s VIP changed: his clan's Pro looked at again. */
export async function refreshProOf(uid: string) {
  const m = await memberOf(await db(), uid);
  if (m) await refreshPro(m.clan);
}

/** At the server's start: every clan looked at, so a clan whose leader already has VIP Pro is Pro without a word. */
export async function refreshAllPro() {
  const clans = await (await db()).collection("clans").getFullList({ fields: "id" });
  for (const c of clans) await refreshPro(c.id, true);
}

/** Each minute: the clans whose notice is over. */
export async function clanProTick() {
  const client = await db();
  const due = await client.collection("clans").getFullList({ filter: client.filter('proEnds != "" && proEnds <= {:now}', { now: pbDate(Date.now()) }), fields: "id" });
  for (const c of due) await refreshPro(c.id).catch((e) => console.error("clan pro failed", c.id, e));
}

/** The clan [uid] is in, and that it's Pro. */
async function myProClan(uid: string) {
  const client = await db();
  const me = await myMembership(client, uid);
  const clan = await client.collection("clans").getOne(me.clan);
  if (clan.pro !== true) throw new ClanError("not pro");
  return { client, me, clan };
}

// ---- the sponsor ----

/** A member with VIP Pro keeps his clan Pro. One sponsor a clan: another may take over only once the first has no VIP Pro. */
export async function sponsorClan(idToken: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  return forClan(me.clan, async () => {
    const [user, clan] = await Promise.all([
      client.collection("users").getOne(uid, { fields: "vipPro" }),
      client.collection("clans").getOne(me.clan, { fields: "sponsor" }),
    ]);
    if (user.vipPro !== true) throw new ClanError("vip pro");
    if (clan.sponsor === uid) return { ok: true };
    if (clan.sponsor) {
      const now = await maybe(client.collection("users").getOne(clan.sponsor, { fields: "vipPro" }));
      if (now?.vipPro === true) throw new ClanError("sponsored");
    }
    await client.collection("clans").update(me.clan, { sponsor: uid, sponsorSince: pbDate(Date.now()) });
    await line({ clan: me.clan, user: uid, kind: "sponsor" });
    await refreshPro(me.clan);
    return { ok: true };
  });
}

/** The sponsor stops; the clan's notice starts if its leader has no VIP Pro. */
export async function stopSponsoring(idToken: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  return forClan(me.clan, async () => {
    const clan = await client.collection("clans").getOne(me.clan, { fields: "sponsor" });
    if (clan.sponsor !== uid) throw new ClanError("not allowed");
    await client.collection("clans").update(me.clan, { sponsor: "", sponsorSince: "" });
    await refreshPro(me.clan);
    return { ok: true };
  });
}

// ---- the clan store ----

/** An item's price now (the owner's, or the usual), and whether the store shows it. */
export function storePrice(id: string) {
  const usual = clanPriceOf(id);
  if (!usual) return null;
  const s = settings().clanStore;
  return { ...(s.prices[id] ?? usual), hidden: s.hidden.includes(id) };
}

/** The leader buys an item or a pack with the clan's wallet. It's the clan's for good. */
export async function buyClanItem(idToken: string, idIn: unknown) {
  const id = String(idIn ?? "");
  const price = storePrice(id);
  if (!price) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (me.role !== "leader") throw new ClanError("not allowed");
  return forClan(me.clan, async () => {
    const clan = await client.collection("clans").getOne(me.clan, { fields: "pro,coins,diamonds,owned" });
    if (clan.pro !== true) throw new ClanError("not pro");
    if (price.hidden) throw new ClanError("hidden");
    const owned: string[] = Array.isArray(clan.owned) ? clan.owned : [];
    if (owned.includes(id)) throw new ClanError("owned");
    if (price.coins > (Number(clan.coins) || 0) || price.diamonds > (Number(clan.diamonds) || 0)) throw new ClanError("funds");
    const items = id.startsWith("pack.") ? [id, ...CLAN_PACKS[id.slice(5)]] : [id];
    const batch = client.createBatch();
    batch.collection("clans").update(me.clan, { "coins-": price.coins, "diamonds-": price.diamonds, owned: [...new Set([...owned, ...items])] });
    batch.collection("clan_wallet").create({ clan: me.clan, kind: "buy", coins: -price.coins, diamonds: -price.diamonds, user: uid, note: id });
    await batch.send();
    return { ok: true };
  });
}

/** The leader puts on an item the clan owns (or a free one), or takes a place's item off ([id] ""). */
export async function wearClanItem(idToken: string, slotIn: unknown, idIn: unknown) {
  const slot = String(slotIn ?? ""), id = String(idIn ?? "");
  if (!CLAN_SLOTS.includes(slot) || (id && slotOf(id) !== slot)) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (me.role !== "leader") throw new ClanError("not allowed");
  return forClan(me.clan, async () => {
    const clan = await client.collection("clans").getOne(me.clan, { fields: "pro,owned,equipped" });
    if (clan.pro !== true) throw new ClanError("not pro");
    const owned: string[] = Array.isArray(clan.owned) ? clan.owned : [];
    const price = storePrice(id);
    if (id && !owned.includes(id) && !(price && price.coins + price.diamonds === 0 && !price.hidden)) throw new ClanError("not owned");
    const equipped: Record<string, string> = { ...(clan.equipped ?? {}) };
    if (id) equipped[slot] = id;
    else delete equipped[slot];
    await client.collection("clans").update(me.clan, { equipped });
    return { equipped };
  });
}

/** The leader puts on a whole pack the clan owns. */
export async function wearClanPack(idToken: string, packIn: unknown) {
  const pack = String(packIn ?? "");
  const items = CLAN_PACKS[pack];
  if (!items) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (me.role !== "leader") throw new ClanError("not allowed");
  return forClan(me.clan, async () => {
    const clan = await client.collection("clans").getOne(me.clan, { fields: "pro,owned,equipped" });
    if (clan.pro !== true) throw new ClanError("not pro");
    if (!(Array.isArray(clan.owned) && clan.owned.includes(`pack.${pack}`))) throw new ClanError("not owned");
    const equipped: Record<string, string> = { ...(clan.equipped ?? {}) };
    for (const id of items) equipped[slotOf(id)] = id;
    await client.collection("clans").update(me.clan, { equipped });
    return { equipped };
  });
}

// ---- what else Pro gives ----

const clean = (v: unknown, max: number) => {
  const text = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
  if (hasBadWord(text, settings().badWords)) throw new ClanError("invalid");
  return text;
};

/** The second pinned line ("" takes it down). */
export async function pinSecond(idToken: string, text: unknown) {
  const { uid } = await signedIn(idToken);
  const { client, me } = await myProClan(uid);
  if (!may(me.role, "pin")) throw new ClanError("not allowed");
  await client.collection("clans").update(me.clan, { pinned2: clean(text, 200) });
  return { ok: true };
}

/** A co-leader or the leader tells every member's phone, once a day. */
export async function announce(idToken: string, textIn: unknown) {
  const text = clean(textIn, 200);
  if (!text) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (!may(me.role, "pin")) throw new ClanError("not allowed");
  return forClan(me.clan, async () => {
    const clan = await client.collection("clans").getOne(me.clan, { fields: "pro,name,tag,announcedOn" });
    if (clan.pro !== true) throw new ClanError("not pro");
    const today = dzDay(Date.now());
    if (clan.announcedOn === today) throw new ClanError("today");
    await client.collection("clans").update(me.clan, { announcedOn: today });
    await line({ clan: me.clan, user: uid, kind: "announce", text });
    const others = await client.collection("clan_members").getFullList({ filter: client.filter("clan = {:clan} && user != {:uid}", { clan: me.clan, uid }), fields: "user" });
    void pushToUsers(others.map((o) => o.user), { sender: CLAN_SENDER, title: `[${clan.tag}] ${clan.name}`, body: text }).catch(() => {});
    return { ok: true };
  });
}

/** A co-leader or the leader asks the clan: a poll of 2 to 6 answers, in the chat. */
export async function newPoll(idToken: string, question: unknown, answers: unknown) {
  const q = clean(question, 120);
  const options = (Array.isArray(answers) ? answers : []).map((a) => clean(a, 60)).filter(Boolean).slice(0, 6);
  if (!q || options.length < 2) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const { me } = await myProClan(uid);
  if (!may(me.role, "pin")) throw new ClanError("not allowed");
  await line({ clan: me.clan, user: uid, kind: "poll", text: q, data: { options, votes: {} } });
  return { ok: true };
}

/** A member's answer to a poll (one each; the same again takes it back). */
export async function votePoll(idToken: string, id: string, answer: unknown) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  return forClan(me.clan, async () => {
    const poll = await maybe(client.collection("clan_messages").getOne(id));
    if (!poll || poll.clan !== me.clan || poll.kind !== "poll") throw new ClanError("invalid");
    const i = Number(answer), options: unknown[] = poll.data?.options ?? [];
    if (!Number.isInteger(i) || i < 0 || i >= options.length) throw new ClanError("invalid");
    const votes: Record<string, number> = { ...(poll.data?.votes ?? {}) };
    if (votes[uid] === i) delete votes[uid];
    else votes[uid] = i;
    await client.collection("clan_messages").update(id, { data: { ...poll.data, votes } });
    return { ok: true };
  });
}

const MAX_EVENTS = 30;

/** A co-leader or the leader puts an event on the clan's calendar, with a line in the chat. */
export async function addClanEvent(idToken: string, titleIn: unknown, atIn: unknown) {
  const title = clean(titleIn, 80), at = Number(atIn);
  if (!title || !Number.isFinite(at) || at < Date.now() || at > Date.now() + 366 * 86_400_000) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const { client, me } = await myProClan(uid);
  if (!may(me.role, "pin")) throw new ClanError("not allowed");
  const ahead = client.filter("clan = {:clan} && at >= {:now}", { clan: me.clan, now: pbDate(Date.now()) });
  if ((await client.collection("clan_events").getList(1, 1, { filter: ahead, fields: "id" })).totalItems >= MAX_EVENTS) throw new ClanError("full");
  await client.collection("clan_events").create({ clan: me.clan, title, at: pbDate(at), by: uid });
  await line({ clan: me.clan, user: uid, kind: "event", text: title, data: { at } });
  return { ok: true };
}

/** A co-leader or the leader takes an event off. */
export async function deleteClanEvent(idToken: string, id: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (!may(me.role, "pin")) throw new ClanError("not allowed");
  const event = await maybe(client.collection("clan_events").getOne(id));
  if (!event || event.clan !== me.clan) throw new ClanError("invalid");
  await client.collection("clan_events").delete(id);
  return { ok: true };
}

/**
 * A Pro clan's member arrives in a room: everyone there sees the entrance his clan wears. Once a player a room; the app asks,
 * the server reads what's true.
 */
export function clanEntrances(room: Room) {
  const shown = new Set<string>();
  room.onMessage("clan_entrance", async (client) => {
    const uid = String((client as { auth?: { account?: { uid?: string } } }).auth?.account?.uid ?? "");
    if (!uid || shown.has(uid)) return;
    shown.add(uid);
    try {
      const pb = await db();
      const m = await memberOf(pb, uid);
      if (!m) return;
      const [clan, user] = await Promise.all([
        pb.collection("clans").getOne(m.clan, { fields: "pro,equipped,name,tag" }),
        pb.collection("users").getOne(uid, { fields: "name,username,avatar" }),
      ]);
      const enter = String(clan.equipped?.enter ?? "");
      if (clan.pro !== true || !enter) return;
      room.broadcast("clan_entrance", {
        n: Number(enter.split(".")[1]) || 1, color: String(clan.equipped?.color ?? "color.gold").split(".")[1],
        name: user.name || user.username, avatar: Number(user.avatar) || 0, clan: clan.name, tag: clan.tag,
      });
    } catch (e) {
      console.error("clan entrance failed", e);
    }
  });
}

/** A members-only room: may [uid] come in with [others] there? In the same Pro clan as one of them. */
export async function sameProClan(uid: string, others: string[]) {
  const client = await db();
  const me = await memberOf(client, uid);
  if (!me) return false;
  const clan = await maybe(client.collection("clans").getOne(me.clan, { fields: "pro" }));
  if (clan?.pro !== true) return false;
  for (const other of others) if ((await memberOf(client, other))?.clan === me.clan) return true;
  return false;
}
