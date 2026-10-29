import { randomBytes } from "node:crypto";
import type PocketBase from "pocketbase";
import {
  currentPlans, db, type Done, forPlayer, grantVip, isFriendOfAny, maybe, parseDate, pbDate, pushToUsers, saveDone, signedIn,
} from "./accounts.js";
import { weekKey } from "./missions.js";
import { prizeFor } from "./plans.js";

/**
 * Clans: making one (💎100, from level 5), its look and who may join (open, on request, closed; from a level), joining
 * (a 24-hour wait after leaving one), requests, invitations, roles (leader, co-leader, elder, member: who may do what
 * is in RIGHTS), leaving (the leader's place goes to the highest role, longest in it first; the last one out ends the
 * clan), clearing out the inactive, the pinned line. The clan's XP is its members' game XP (accounts.recordResult);
 * its level gives its seats. The chat is in PocketBase (clan_messages): members write their own lines there.
 */

export const CLAN_PRICE = 100; // diamonds
export const RENAME_PRICE = 50; // diamonds: a new name or tag
export const CLAN_MIN_LEVEL = 5; // a player's level, to make a clan
export const REJOIN_MS = 24 * 60 * 60_000; // after leaving a clan
export const INACTIVE_DAYS = 14;

/** The clan XP each level starts at: level 1 at 0 … level 7 (the last) at 105,000. */
export const CLAN_LEVELS = [0, 5000, 15000, 30000, 50000, 75000, 105000];
export const clanLevel = (xp: number) => CLAN_LEVELS.filter((at) => xp >= at).length;
export const clanSeats = (xp: number) => 20 + 5 * (clanLevel(xp) - 1); // 20 … 50

/** A player's level from his XP (as the app counts it: level n from 100·(n−1)²). */
export const playerLevel = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 100));

export type Role = "leader" | "coLeader" | "elder" | "member";
const RANK: Record<Role, number> = { leader: 0, coLeader: 1, elder: 2, member: 3 };

/** The lowest role that may do each thing (and every role above it). */
export const RIGHTS = { accept: "elder", kick: "coLeader", promote: "coLeader", pin: "coLeader", edit: "leader" } as const;
const may = (role: Role, right: keyof typeof RIGHTS) => RANK[role] <= RANK[RIGHTS[right]];

export class ClanError extends Error {}

const SHAPES = ["shield", "hexagon", "circle", "star", "bookmark"];
const JOINS = ["open", "request", "closed"];
export type Look = { name: string; tag: string; motto: string; shape: string; color: number; join: string; minLevel: number };

/** A clan's look as the app sent it, checked; anything off throws "invalid". */
export function cleanLook(v: unknown): Look {
  const o = (v ?? {}) as Record<string, unknown>;
  const name = String(o.name ?? "").trim().replace(/\s+/g, " ");
  const tag = String(o.tag ?? "").trim().toUpperCase();
  const motto = String(o.motto ?? "").trim();
  const color = Number(o.color), minLevel = Number(o.minLevel ?? 1);
  if (name.length < 3 || name.length > 20 || !/^[A-Z0-9]{2,4}$/.test(tag) || motto.length > 40) throw new ClanError("invalid");
  if (!SHAPES.includes(String(o.shape)) || !JOINS.includes(String(o.join))) throw new ClanError("invalid");
  if (!Number.isInteger(color) || color < 0 || color > 7 || !Number.isInteger(minLevel) || minLevel < 1 || minLevel > 50) {
    throw new ClanError("invalid");
  }
  return { name, tag, motto, shape: String(o.shape), color, join: String(o.join), minLevel };
}

const ID = "abcdefghijklmnopqrstuvwxyz0123456789";
const newId = () => Array.from(randomBytes(15), (b) => ID[b % ID.length]).join("");

/** One clan's changes at a time (seats, members, leader), after the player's own lock. */
const forClan = <T>(clan: string, fn: () => Promise<T>) => forPlayer(`clan:${clan}`, fn);

type Member = { id: string; clan: string; user: string; role: Role; created: string };

async function memberOf(client: PocketBase, uid: string): Promise<Member | null> {
  const { items } = await client.collection("clan_members").getList(1, 1, { filter: client.filter("user = {:uid}", { uid }) });
  return (items[0] as unknown as Member) ?? null;
}

async function myMembership(client: PocketBase, uid: string): Promise<Member> {
  const m = await memberOf(client, uid);
  if (!m) throw new ClanError("not in a clan");
  return m;
}

/** He may join a clan now: in none, and not left one less than 24 hours ago. */
function free(user: Record<string, any>) {
  if (user.clan) throw new ClanError("in a clan");
  if (parseDate(user.clanLeftAt) > Date.now() - REJOIN_MS) throw new ClanError("wait");
}

/** Makes a clan, its maker its leader: for CLAN_PRICE diamonds, from level CLAN_MIN_LEVEL. */
export async function createClan(idToken: string, look: unknown) {
  const l = cleanLook(look);
  const { uid } = await signedIn(idToken);
  return forPlayer(uid, async () => {
    const client = await db();
    const user = await client.collection("users").getOne(uid, { fields: "xp,diamonds,clan,clanLeftAt" });
    free(user);
    if (playerLevel(Number(user.xp) || 0) < CLAN_MIN_LEVEL) throw new ClanError("level");
    if (!(Number(user.diamonds) >= CLAN_PRICE)) throw new ClanError("funds");
    const id = newId();
    const batch = client.createBatch();
    batch.collection("clans").create({ id, ...l, xp: 0, members: 1, pinned: "" });
    batch.collection("clan_members").create({ clan: id, user: uid, role: "leader" });
    batch.collection("users").update(uid, { clan: id, "diamonds-": CLAN_PRICE });
    try {
      await batch.send();
    } catch (e) {
      throw new ClanError((e as { status?: number }).status === 400 ? "taken" : "failed"); // (the name or the tag)
    }
    return { id };
  });
}

/** The leader changes the clan's look or who may join; a new name or tag costs RENAME_PRICE diamonds. */
export async function editClan(idToken: string, look: unknown) {
  const l = cleanLook(look);
  const { uid } = await signedIn(idToken);
  return forPlayer(uid, async () => {
    const client = await db();
    const me = await myMembership(client, uid);
    if (!may(me.role, "edit")) throw new ClanError("not allowed");
    return forClan(me.clan, async () => {
      const clan = await client.collection("clans").getOne(me.clan);
      const renamed = clan.name !== l.name || clan.tag !== l.tag;
      const batch = client.createBatch();
      if (renamed) {
        const { diamonds } = await client.collection("users").getOne(uid, { fields: "diamonds" });
        if (!(Number(diamonds) >= RENAME_PRICE)) throw new ClanError("funds");
        batch.collection("users").update(uid, { "diamonds-": RENAME_PRICE });
      }
      batch.collection("clans").update(me.clan, l);
      try {
        await batch.send();
      } catch (e) {
        throw new ClanError((e as { status?: number }).status === 400 ? "taken" : "failed");
      }
      return { paid: renamed ? RENAME_PRICE : 0 };
    });
  });
}

/** [uid] into [clan] (both locked by the caller): seats and level checked; his invitation and request are used up. */
async function addMember(client: PocketBase, clanId: string, uid: string) {
  const [clan, user] = await Promise.all([
    client.collection("clans").getOne(clanId),
    client.collection("users").getOne(uid, { fields: "xp,clan,clanLeftAt" }),
  ]);
  free(user);
  if (playerLevel(Number(user.xp) || 0) < (Number(clan.minLevel) || 1)) throw new ClanError("level");
  if ((Number(clan.members) || 0) >= clanSeats(Number(clan.xp) || 0)) throw new ClanError("full");
  const pair = client.filter("clan = {:clan} && user = {:uid}", { clan: clanId, uid });
  const [invites, requests] = await Promise.all([
    client.collection("clan_invites").getFullList({ filter: pair, fields: "id" }),
    client.collection("clan_requests").getFullList({ filter: pair, fields: "id" }),
  ]);
  const batch = client.createBatch();
  batch.collection("clan_members").create({ clan: clanId, user: uid, role: "member" });
  batch.collection("clans").update(clanId, { "members+": 1 });
  batch.collection("users").update(uid, { clan: clanId });
  batch.collection("clan_messages").create({ clan: clanId, user: uid, kind: "joined" });
  for (const r of invites) batch.collection("clan_invites").delete(r.id);
  for (const r of requests) batch.collection("clan_requests").delete(r.id);
  await batch.send();
}

/** Joins an open clan (or one he's invited to); a clan on request gets his request; a closed one refuses. */
export async function joinClan(idToken: string, clanId: string) {
  const { uid } = await signedIn(idToken);
  return forPlayer(uid, () =>
    forClan(clanId, async () => {
      const client = await db();
      const clan = await maybe(client.collection("clans").getOne(clanId));
      if (!clan) throw new ClanError("unknown");
      const pair = client.filter("clan = {:clan} && user = {:uid}", { clan: clanId, uid });
      const invited = (await client.collection("clan_invites").getList(1, 1, { filter: pair, fields: "id" })).items.length > 0;
      if (clan.join === "closed" && !invited) throw new ClanError("closed");
      if (clan.join === "request" && !invited) {
        const user = await client.collection("users").getOne(uid, { fields: "xp,clan,clanLeftAt" });
        free(user);
        if (playerLevel(Number(user.xp) || 0) < (Number(clan.minLevel) || 1)) throw new ClanError("level");
        const asked = await client.collection("clan_requests").getList(1, 1, { filter: pair, fields: "id" });
        if (asked.items.length === 0) {
          await client.collection("clan_requests").create({ clan: clanId, user: uid });
          const deciders = await client.collection("clan_members").getFullList({
            filter: client.filter('clan = {:clan} && (role = "leader" || role = "coLeader" || role = "elder")', { clan: clanId }),
            fields: "user",
          });
          const who = await client.collection("users").getOne(uid, { fields: "name,username" });
          void pushToUsers(deciders.map((d) => d.user), {
            sender: CLAN_SENDER, title: `[${clan.tag}] ${clan.name}`, body: `➕ ${who.name || who.username}`,
          }).catch(() => {});
        }
        return { joined: false, requested: true };
      }
      await addMember(client, clanId, uid);
      return { joined: true, requested: false };
    }),
  );
}

/** [m] out of his clan (both locked by the caller): the clan's last one ends it; a leader's place goes on. */
async function removeMember(client: PocketBase, m: Member, kind: "left" | "kicked") {
  const others = (await client.collection("clan_members").getFullList({
    filter: client.filter("clan = {:clan} && user != {:uid}", { clan: m.clan, uid: m.user }),
  })) as unknown as Member[];
  const batch = client.createBatch();
  batch.collection("users").update(m.user, { clan: "", clanLeftAt: pbDate(Date.now()) });
  if (others.length === 0) {
    batch.collection("clans").delete(m.clan); // (its members, chat, requests and invitations with it)
    return batch.send();
  }
  batch.collection("clan_members").delete(m.id);
  batch.collection("clans").update(m.clan, { "members-": 1 });
  batch.collection("clan_messages").create({ clan: m.clan, user: m.user, kind: "left", data: { kicked: kind === "kicked" } });
  if (m.role === "leader") {
    const next = others.sort((a, b) => RANK[a.role] - RANK[b.role] || a.created.localeCompare(b.created))[0];
    batch.collection("clan_members").update(next.id, { role: "leader" });
    batch.collection("clan_messages").create({ clan: m.clan, user: next.user, kind: "leader" });
  }
  return batch.send();
}

/** Leaves his clan; 24 hours before he may join another. */
export async function leaveClan(idToken: string) {
  const { uid } = await signedIn(idToken);
  return forPlayer(uid, async () => {
    const client = await db();
    const me = await myMembership(client, uid);
    await forClan(me.clan, () => removeMember(client, me, "left"));
    return { ok: true };
  });
}

/** An elder or above takes a player's request ([accept]) or turns it down. */
export async function answerRequest(idToken: string, player: string, accept: boolean) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (!may(me.role, "accept")) throw new ClanError("not allowed");
  return forPlayer(player, () =>
    forClan(me.clan, async () => {
      const pair = client.filter("clan = {:clan} && user = {:uid}", { clan: me.clan, uid: player });
      const { items } = await client.collection("clan_requests").getList(1, 1, { filter: pair, fields: "id" });
      if (items.length === 0) throw new ClanError("no request");
      if (!accept) {
        await client.collection("clan_requests").delete(items[0].id);
        return { joined: false };
      }
      await addMember(client, me.clan, player);
      return { joined: true };
    }),
  );
}

/**
 * What a co-leader or the leader does to a member below him: "promote" (up to just below himself), "demote", "kick";
 * the leader alone: "leader" (the member leads, he becomes a co-leader).
 */
export async function changeMember(idToken: string, player: string, action: string) {
  const { uid } = await signedIn(idToken);
  if (player === uid) throw new ClanError("not allowed");
  return forPlayer(player, async () => {
    const client = await db();
    const me = await myMembership(client, uid);
    return forClan(me.clan, async () => {
      const them = await memberOf(client, player);
      if (!them || them.clan !== me.clan) throw new ClanError("not in the clan");
      const mine = RANK[me.role], theirs = RANK[them.role];
      const roles = Object.keys(RANK) as Role[];
      if (action === "leader") {
        if (me.role !== "leader") throw new ClanError("not allowed");
        const batch = client.createBatch();
        batch.collection("clan_members").update(them.id, { role: "leader" });
        batch.collection("clan_members").update(me.id, { role: "coLeader" });
        batch.collection("clan_messages").create({ clan: me.clan, user: player, kind: "leader" });
        await batch.send();
        return { role: "leader" };
      }
      if (theirs <= mine) throw new ClanError("not allowed"); // only those below him
      if (action === "kick") {
        if (!may(me.role, "kick")) throw new ClanError("not allowed");
        await removeMember(client, them, "kicked");
        return { role: "" };
      }
      if (!may(me.role, "promote")) throw new ClanError("not allowed");
      const to = action === "promote" ? theirs - 1 : action === "demote" ? theirs + 1 : -1;
      if (to <= mine || to > RANK.member) throw new ClanError("not allowed");
      await client.collection("clan_members").update(them.id, { role: roles[to] });
      return { role: roles[to] };
    });
  });
}

/** A co-leader or the leader clears out the members below him not seen for INACTIVE_DAYS: how many went. */
export async function removeInactive(idToken: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (!may(me.role, "kick")) throw new ClanError("not allowed");
  const members = (await client.collection("clan_members").getFullList({
    filter: client.filter("clan = {:clan}", { clan: me.clan }),
  })) as unknown as Member[];
  const cutoff = Date.now() - INACTIVE_DAYS * 86_400_000;
  let gone = 0;
  for (const m of members) {
    if (RANK[m.role] <= RANK[me.role]) continue;
    const seen = await maybe(client.collection("presence").getOne(m.user, { fields: "at,state" }));
    const last = seen?.state && seen.state !== "offline" ? Date.now() : parseDate(seen?.at) || parseDate(m.created);
    if (last > cutoff) continue;
    await forPlayer(m.user, () => forClan(me.clan, async () => {
      const still = await memberOf(client, m.user);
      if (still?.clan === me.clan) await removeMember(client, still, "kicked");
    }));
    gone++;
  }
  return { removed: gone };
}

/** A member invites a friend: the friend is told (a popup), and may come in past "request". */
export async function inviteToClan(idToken: string, friend: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (!(await isFriendOfAny(uid, [friend]))) throw new ClanError("not a friend");
  const [clan, them, by] = await Promise.all([
    client.collection("clans").getOne(me.clan),
    client.collection("users").getOne(friend, { fields: "clan" }),
    client.collection("users").getOne(uid, { fields: "name,username" }),
  ]);
  if (them.clan) throw new ClanError("in a clan");
  const pair = client.filter("clan = {:clan} && user = {:uid}", { clan: me.clan, uid: friend });
  if ((await client.collection("clan_invites").getList(1, 1, { filter: pair, fields: "id" })).items.length === 0) {
    await client.collection("clan_invites").create({ clan: me.clan, user: friend, by: uid });
  }
  await client.collection("notices").create({
    user: friend, kind: "clanInvite", text: `${by.name || by.username} invites you to ${clan.name}`,
    data: { clan: me.clan, name: clan.name, tag: clan.tag, color: clan.color, shape: clan.shape, by: by.name || by.username },
  });
  return { ok: true };
}

/** A co-leader or the leader pins a line at the top of the clan's chat ("" takes it down). */
export async function pinClan(idToken: string, text: unknown) {
  const line = String(text ?? "").trim().slice(0, 200);
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  if (!may(me.role, "pin")) throw new ClanError("not allowed");
  await client.collection("clans").update(me.clan, { pinned: line });
  return { ok: true };
}

/** A clan push's sender: a tap opens the clan (the app's Push). */
export const CLAN_SENDER = "clan";

/** A member opened a room: a card with Join in the clan's chat, and the others' phones told. */
export async function shareRoom(idToken: string, roomId: unknown, game: unknown) {
  const room = String(roomId ?? ""), g = String(game ?? "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(room) || !/^[a-z]{1,20}$/.test(g)) throw new ClanError("invalid");
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await myMembership(client, uid);
  const [clan, who, others] = await Promise.all([
    client.collection("clans").getOne(me.clan, { fields: "name,tag" }),
    client.collection("users").getOne(uid, { fields: "name,username" }),
    client.collection("clan_members").getFullList({ filter: client.filter("clan = {:clan} && user != {:uid}", { clan: me.clan, uid }), fields: "user" }),
  ]);
  await client.collection("clan_messages").create({ clan: me.clan, user: uid, kind: "room", data: { roomId: room, game: g } });
  void pushToUsers(others.map((o) => o.user), {
    sender: CLAN_SENDER, title: `[${clan.tag}] ${clan.name}`, body: `🎮 ${who.name || who.username} · ${g}`, roomId: room,
  }).catch(() => {});
  return { ok: true };
}

/** The weekly chest: points each member brings, for bronze, silver, gold; what every member who played wins. */
export const CHESTS = [
  { perMember: 100, coins: 300, diamonds: 0 },
  { perMember: 250, coins: 800, diamonds: 5 },
  { perMember: 500, coins: 1500, diamonds: 15 },
];

/** The highest chest a clan of [members] opened with [points] (-1: none). */
export function chestFor(points: number, members: number) {
  return CHESTS.findLastIndex((c) => points >= c.perMember * Math.max(1, members));
}

/**
 * Last week's chests and clan ranking prizes, once (done.clanWeek): every member who played for his clan that week
 * (points in clan_scores) and is still in it gets its highest chest's prize and its place's (the admin's plan), told by
 * a notice and on his phone.
 */
export async function clanWeek(done: Done) {
  const last = weekKey(Date.now() - 7 * 86_400_000);
  if (done.clanWeek === last) return;
  done.clanWeek = last;
  await saveDone(done);
  const client = await db();
  const tiers = currentPlans().clanrewards ?? [];
  const weeks = await client.collection("clan_weeks").getFullList({ filter: client.filter("week = {:last}", { last }), sort: "-points" });
  for (const [i, row] of weeks.entries()) {
    try {
      const clan = await maybe(client.collection("clans").getOne(row.clan));
      if (!clan) continue;
      const [members, scores] = await Promise.all([
        client.collection("clan_members").getFullList({ filter: client.filter("clan = {:clan}", { clan: row.clan }), fields: "user" }),
        client.collection("clan_scores").getFullList({
          filter: client.filter("clan = {:clan} && week = {:last} && points > 0", { clan: row.clan, last }), fields: "user",
        }),
      ]);
      const playedThere = new Set(scores.map((s) => s.user));
      const played = members.map((m) => m.user).filter((u) => playedThere.has(u));
      const chest = chestFor(Number(row.points) || 0, Number(clan.members) || 1);
      const prize = prizeFor(tiers, i + 1);
      const coins = (chest >= 0 ? CHESTS[chest].coins : 0) + (prize?.coins ?? 0);
      const diamonds = (chest >= 0 ? CHESTS[chest].diamonds : 0) + (prize?.diamonds ?? 0);
      const vipDays = prize?.vipDays ?? 0;
      if (played.length === 0 || (coins === 0 && diamonds === 0 && vipDays === 0)) continue;
      for (const uid of played) {
        await forPlayer(uid, async () => {
          const batch = client.createBatch();
          if (coins || diamonds) batch.collection("users").update(uid, { "coins+": coins, "diamonds+": diamonds });
          batch.collection("notices").create({
            user: uid, kind: "clanChest", text: `${clan.name}: #${i + 1} last week`,
            data: { clan: clan.name, tag: clan.tag, rank: i + 1, chest, coins, diamonds, vipDays, week: last },
          });
          await batch.send();
        });
        if (vipDays) await grantVip(uid, "vip", vipDays);
      }
      void pushToUsers(played, {
        sender: CLAN_SENDER, title: `[${clan.tag}] ${clan.name}`,
        body: `🎁 #${i + 1} · ${[coins && `+${coins} 🪙`, diamonds && `+${diamonds} 💎`, vipDays && `+${vipDays} VIP`].filter(Boolean).join(" ")}`,
      }).catch(() => {});
    } catch (e) {
      console.error("clan week prizes failed for", row.clan, e);
    }
  }
}
