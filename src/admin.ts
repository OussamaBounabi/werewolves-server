import { createHash } from "node:crypto";
import { statfs, stat, readdir } from "node:fs/promises";
import os from "node:os";
import { matchMaker } from "colyseus";
import {
  announce, currentPlans, db, findPlayer, forPlayer, ledger, maybe, parseDate, pbDate, pushToUsers, savePlan, settings, type Staff,
} from "./accounts.js";
import { AVATARS, FRAMES, FREE_AVATARS } from "./avatars.js";
import { CATEGORIES, WORDS } from "./imposterWords.js";
import { MYSTERY_CATEGORIES, ITEMS } from "./mysteryItems.js";
import { onlineCount } from "./presence.js";
import { chatLines } from "./rooms/moderate.js";
import { eventsOn, type Moderator } from "./plans.js";

/**
 * The admin app's server side, beyond accounts.ts's support tools: the staff and the log of what they did, the
 * settings the apps read (/api/config), every game's history, players' wallets and items, the economy, the reports'
 * queue and the cheating signs, targeted notifications and scheduled announcements, the numbers (retention, versions,
 * the server's health) and the apps' crashes, and the games' content.
 */

const DZ_MS = 60 * 60_000; // Algeria time
const dzDay = (ms: number) => new Date(ms + DZ_MS).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const name = (u: Record<string, any> | null | undefined) => String(u?.name || u?.username || "?");

// ---- the staff and their log ----

/** What an admin did: written once it worked (the admin app's endpoints do it for every change). */
export async function logAction(who: Staff, action: string, target: string, details: unknown) {
  const json = JSON.stringify(details ?? null);
  await (await db()).collection("admin_log").create({
    who: who.uid, email: who.email, role: who.role, action: action.slice(0, 60), target: target.slice(0, 60),
    details: json.length > 3500 ? { cut: json.slice(0, 3500) } : details ?? null,
  });
}

/** The log, newest first, 50 a page ([target]: what was done to one player, clan or room). */
export async function adminLog(page: number, target: string) {
  const client = await db();
  const list = await client.collection("admin_log").getList(Math.max(1, page), 50, {
    sort: "-created", filter: target ? client.filter("target = {:target}", { target }) : "",
  });
  return {
    page: list.page, pages: list.totalPages,
    items: list.items.map((r) => ({ email: r.email, role: r.role, action: r.action, target: r.target, details: r.details, at: r.created })),
  };
}

/** The owner's moderators. */
export const staffList = () => currentPlans().staff ?? [];

/** The owner adds a moderator (an account, by its username or e-mail) or takes one away. */
export async function setStaff(who: string, add: boolean) {
  const list = staffList();
  if (!add) {
    const kept = list.filter((m) => m.uid !== who && m.username !== who);
    await savePlan("staff", kept);
    return kept;
  }
  const user = await findPlayer(who);
  if (list.some((m) => m.uid === user.id)) return list;
  const moderator: Moderator = { uid: user.id, name: name(user), username: String(user.username ?? ""), added: new Date().toISOString() };
  const next = [...list, moderator].slice(0, 50);
  await savePlan("staff", next);
  return next;
}

// ---- what the apps read ----

/** GET /api/config: the switches, the daily reward, the wheel, clans' prices, the oldest app allowed, bad words, events. */
export function publicConfig() {
  const s = settings();
  return {
    switches: s.switches,
    daily: s.daily,
    wheel: s.wheel,
    clan: { price: s.clan.price, rename: s.clan.rename, minLevel: s.clan.minLevel, levels: s.clan.levels },
    minBuild: s.minBuild,
    badWords: s.badWords,
    bots: s.bots,
    events: eventsOn(currentPlans().events).map(({ id, title, kind, factor, end, games }) => ({ id, title, kind, factor, end, games })),
  };
}

// ---- every game's history ----

/** Finished games, newest first, 50 a page: one game's, or one player's (any game). */
export async function gameHistory(game: string, uid: string, page: number) {
  const client = await db();
  const filters = [
    game ? client.filter("game = {:game}", { game }) : "",
    uid ? client.filter("uids ~ {:uid}", { uid }) : "",
  ].filter(Boolean);
  const list = await client.collection("game_log").getList(Math.max(1, page), 50, { sort: "-created", filter: filters.join(" && ") });
  return {
    page: list.page, pages: list.totalPages, total: list.totalItems,
    items: list.items.map((r) => ({ game: r.game, minutes: r.minutes, players: r.players, at: r.created })),
  };
}

// ---- players: wallet, items, history ----

/** The owner adds or takes coins and diamonds, with a reason the player reads (a support message). */
export async function adminWallet(uid: string, coins: number, diamonds: number, reason: string) {
  if (!Number.isInteger(coins) || !Number.isInteger(diamonds) || (coins === 0 && diamonds === 0)) throw new Error("amounts");
  if (Math.abs(coins) > 10_000_000 || Math.abs(diamonds) > 1_000_000) throw new Error("too much");
  const why = reason.trim().slice(0, 200);
  if (!why) throw new Error("a reason");
  return forPlayer(uid, async () => {
    const client = await db();
    const u = await client.collection("users").getOne(uid, { fields: "coins,diamonds" });
    if ((Number(u.coins) || 0) + coins < 0 || (Number(u.diamonds) || 0) + diamonds < 0) throw new Error("he hasn't that much");
    const change: Record<string, number> = {};
    if (coins) change[coins > 0 ? "coins+" : "coins-"] = Math.abs(coins);
    if (diamonds) change[diamonds > 0 ? "diamonds+" : "diamonds-"] = Math.abs(diamonds);
    const said = [coins && `${coins > 0 ? "+" : ""}${coins} coins`, diamonds && `${diamonds > 0 ? "+" : ""}${diamonds} diamonds`].filter(Boolean);
    const batch = client.createBatch();
    batch.collection("users").update(uid, change);
    ledger(batch, uid, coins, diamonds, "admin", why);
    batch.collection("notices").create({ user: uid, kind: "message", text: `${said.join(", ")}: ${why}` });
    await batch.send();
    const now = await client.collection("users").getOne(uid, { fields: "coins,diamonds" });
    return { coins: Number(now.coins) || 0, diamonds: Number(now.diamonds) || 0 };
  });
}

/** The owner gives an avatar or a frame ([give]), or takes one back (worn: back to a free one). */
export async function adminItem(uid: string, kind: unknown, id: number, give: boolean) {
  if (kind !== "avatar" && kind !== "frame") throw new Error("kind");
  if (!(kind === "avatar" ? AVATARS[id] && !FREE_AVATARS.includes(id) : FRAMES[id])) throw new Error("unknown item");
  const owned = kind === "avatar" ? "avatars" : "frames";
  return forPlayer(uid, async () => {
    const users = (await db()).collection("users");
    const u = await users.getOne(uid, { fields: `${owned},${kind}` });
    const has: number[] = Array.isArray(u[owned]) ? u[owned] : [];
    const update: Record<string, unknown> = { [owned]: give ? [...new Set([...has, id])] : has.filter((x) => x !== id) };
    if (!give && Number(u[kind]) === id) update[kind] = kind === "avatar" ? FREE_AVATARS[0] : 0;
    await users.update(uid, update);
    return { [owned]: update[owned] };
  });
}

/** An offensive name or avatar: the name back to his username (he may change it again tomorrow), the avatar to a free one. */
export async function adminReset(uid: string, what: unknown) {
  const users = (await db()).collection("users");
  return forPlayer(uid, async () => {
    const u = await users.getOne(uid, { fields: "username" });
    if (what === "name") await users.update(uid, { name: String(u.username ?? "").slice(0, 16), nameChangedAt: new Date().toISOString() });
    else if (what === "avatar") await users.update(uid, { avatar: FREE_AVATARS[0], frame: 0 });
    else throw new Error("what");
    return { ok: true };
  });
}

/** A player's wallet history, newest first, 50 a page. */
export async function walletHistory(uid: string, page: number) {
  const client = await db();
  const list = await client.collection("wallet_log").getList(Math.max(1, page), 50, {
    sort: "-created", filter: client.filter("user = {:uid}", { uid }),
  });
  return {
    page: list.page, pages: list.totalPages,
    items: list.items.map((r) => ({ coins: r.coins, diamonds: r.diamonds, source: r.source, note: r.note, at: r.created })),
  };
}

/** What else the admin app shows on a player's sheet: his wallet, items, phone and the other accounts on it, clan. */
export async function playerExtra(uid: string) {
  const client = await db();
  const u = await client.collection("users").getOne(uid, {
    fields: "coins,diamonds,avatars,frames,avatar,frame,device,clan,lastSeen,lang,email,username",
  });
  const device = String(u.device ?? "");
  const [sharing, clan] = await Promise.all([
    device
      ? client.collection("users").getFullList({ filter: client.filter("device = {:device} && id != {:uid}", { device, uid }), fields: "id,name,username,avatar,frame" })
      : Promise.resolve([]),
    u.clan ? maybe(client.collection("clans").getOne(u.clan, { fields: "id,name,tag" })) : Promise.resolve(null),
  ]);
  return {
    coins: Number(u.coins) || 0, diamonds: Number(u.diamonds) || 0,
    avatars: Array.isArray(u.avatars) ? u.avatars : [], frames: Array.isArray(u.frames) ? u.frames : [],
    lastSeen: String(u.lastSeen ?? ""), lang: String(u.lang ?? ""),
    samePhone: sharing.map((s) => ({ uid: s.id, name: name(s), username: s.username, avatar: Number(s.avatar) || 0, frame: Number(s.frame) || 0 })),
    clan: clan ? { id: clan.id, name: clan.name, tag: clan.tag } : null,
  };
}

// ---- the economy ----

/**
 * The coins and diamonds every player holds now, and over the last [days] days where they came from and went
 * (wallet_log, from the day it started).
 */
export async function economy(days: number) {
  const client = await db();
  const since = pbDate(Date.now() - days * DAY_MS);
  // ponytail: every account and every change of the period read at once; SQL views if this ever gets slow
  const [users, rows] = await Promise.all([
    client.collection("users").getFullList({ fields: "coins,diamonds", batch: 2000 }),
    client.collection("wallet_log").getFullList({ filter: client.filter("created >= {:since}", { since }), fields: "coins,diamonds,source,created", batch: 2000 }),
  ]);
  const held = users.reduce((t, u) => ({ coins: t.coins + (Number(u.coins) || 0), diamonds: t.diamonds + (Number(u.diamonds) || 0) }), { coins: 0, diamonds: 0 });
  const sources: Record<string, { coinsIn: number; coinsOut: number; diamondsIn: number; diamondsOut: number }> = {};
  const byDay: Record<string, { coins: number; diamonds: number }> = {};
  for (const r of rows) {
    const s = (sources[r.source] ??= { coinsIn: 0, coinsOut: 0, diamondsIn: 0, diamondsOut: 0 });
    const c = Number(r.coins) || 0, d = Number(r.diamonds) || 0;
    if (c > 0) s.coinsIn += c; else s.coinsOut -= c;
    if (d > 0) s.diamondsIn += d; else s.diamondsOut -= d;
    const day = dzDay(parseDate(r.created));
    const t = (byDay[day] ??= { coins: 0, diamonds: 0 });
    t.coins += c;
    t.diamonds += d;
  }
  return { players: users.length, held, sources, byDay, since };
}

// ---- reports: the queue and their context ----

/** The reports one by one, newest first, those not handled yet or the handled ones; with what the server kept. */
export async function reportQueue(handled: boolean, page: number) {
  const client = await db();
  const list = await client.collection("reports").getList(Math.max(1, page), 30, {
    sort: "-created", filter: handled ? "handled = true" : "handled != true", expand: "target,reporter",
  });
  return {
    page: list.page, pages: list.totalPages, total: list.totalItems,
    items: list.items.map((r) => ({
      id: r.id, reason: r.reason, context: r.context, at: r.created,
      target: { uid: r.target, name: name(r.expand?.target), avatar: Number(r.expand?.target?.avatar) || 0, frame: Number(r.expand?.target?.frame) || 0 },
      reporter: { uid: r.reporter, name: name(r.expand?.reporter) },
      snapshot: r.snapshot ?? null,
      picture: r.picture ? `/api/admin/report-picture?id=${r.id}` : "",
    })),
  };
}

export async function handleReport(id: string, handled: boolean) {
  await (await db()).collection("reports").update(id, { handled });
}

/** A reported Mystery Item picture's bytes (the admin app shows it). */
export async function reportPicture(id: string) {
  const client = await db();
  const r = await client.collection("reports").getOne(id, { fields: "id,collectionId,picture" });
  if (!r.picture) throw new Error("no picture");
  const token = await client.files.getToken();
  const res = await fetch(client.files.getURL(r, r.picture, { token }));
  return { type: res.headers.get("content-type") ?? "image/jpeg", body: Buffer.from(await res.arrayBuffer()) };
}

/** Where the server finds what a report is about: the reported picture, in a Mystery Item room ([GuessRoom]). */
type PictureOf = (roomId: string, uid: string) => Buffer | null;
let pictureOf: PictureOf = () => null;
export function findPicturesWith(find: PictureOf) {
  pictureOf = find;
}

/**
 * Soon after each report (every minute), what it's about is kept with it before it's gone: a room's chat (the room
 * the reporter is in), a friend chat's last messages between the two (only then: the admins read no friend chat
 * otherwise), a Mystery Item picture.
 */
export async function snapReports() {
  const client = await db();
  const { items } = await client.collection("reports").getList(1, 20, { filter: "snapped != true", sort: "created", expand: "reporter" });
  for (const r of items) {
    const snapshot: Record<string, unknown> = {};
    const form = new FormData();
    try {
      const room = String(r.expand?.reporter?.room ?? "");
      if (r.context === "chat") {
        const pair = client.filter("(from = {:a} && to = {:b}) || (from = {:b} && to = {:a})", { a: r.reporter, b: r.target });
        const { items: messages } = await client.collection("messages").getList(1, 20, {
          filter: `(${pair}) && created <= "${r.created}"`, sort: "-created", fields: "from,type,text,created",
        });
        snapshot.chat = messages.reverse().map((m) => ({ uid: m.from, text: m.type === "text" ? m.text : `(${m.type})`, at: m.created }));
      } else if (room) {
        snapshot.room = room;
        snapshot.lines = chatLines(room).slice(-40);
        const picture = String(r.context).startsWith("mystery image") ? pictureOf(room, r.target) : null;
        if (picture) form.append("picture", new Blob([new Uint8Array(picture)], { type: "image/jpeg" }), "picture.jpg");
      }
    } catch (e) {
      console.error("report snapshot failed", r.id, e);
    }
    form.append("snapped", "true");
    form.append("snapshot", JSON.stringify(snapshot));
    await client.collection("reports").update(r.id, form).catch((e) => console.error("report snapshot not saved", r.id, e));
  }
}

// ---- cheating signs ----

/**
 * What looks wrong, for the owner to look at (nothing is done to anyone): one phone with 3 accounts or more; two
 * players who keep meeting at staked tables, the same one winning nearly always; gifts going again and again to the
 * same player; win rates too good to be true. The last 30 days.
 */
export async function cheatFlags() {
  const client = await db();
  const since = pbDate(Date.now() - 30 * DAY_MS);
  const [users, stakes, gifts] = await Promise.all([
    client.collection("users").getFullList({ fields: "id,name,username,avatar,frame,device,stats", batch: 2000 }),
    client.collection("stake_games").getFullList({ filter: client.filter("created >= {:since}", { since }), fields: "players", batch: 2000 }),
    client.collection("wallet_log").getFullList({ filter: client.filter('source = "gift" && created >= {:since}', { since }), fields: "user,note", batch: 2000 }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const who = (uid: string) => {
    const u = byId.get(uid);
    return { uid, name: name(u), avatar: Number(u?.avatar) || 0, frame: Number(u?.frame) || 0 };
  };
  const flags: { kind: string; players: ReturnType<typeof who>[]; why: string; weight: number }[] = [];

  const phones = new Map<string, string[]>();
  for (const u of users) if (u.device) phones.set(u.device, [...(phones.get(u.device) ?? []), u.id]);
  const samePhone = (a: string, b: string) => !!byId.get(a)?.device && byId.get(a)?.device === byId.get(b)?.device;
  for (const [, ids] of phones) {
    if (ids.length >= 3) flags.push({ kind: "phone", players: ids.map(who), why: `${ids.length} accounts on one phone`, weight: ids.length });
  }

  const pairs = new Map<string, { games: number; wins: Record<string, number> }>();
  for (const g of stakes) {
    const players = (Array.isArray(g.players) ? g.players : []) as { id: string; paid: number; got: number }[];
    if (players.length !== 2) continue;
    const [a, b] = [players[0].id, players[1].id].sort();
    const p = pairs.get(`${a} ${b}`) ?? { games: 0, wins: {} };
    p.games++;
    const winner = players.find((x) => x.got > x.paid)?.id;
    if (winner) p.wins[winner] = (p.wins[winner] ?? 0) + 1;
    pairs.set(`${a} ${b}`, p);
  }
  for (const [key, p] of pairs) {
    const [a, b] = key.split(" ");
    const top = Math.max(p.wins[a] ?? 0, p.wins[b] ?? 0);
    if (p.games < 5 || top / p.games < 0.8) continue;
    const phone = samePhone(a, b) ? ", on the same phone" : "";
    flags.push({ kind: "stakes", players: [who(a), who(b)], why: `${p.games} staked games together, one won ${top}${phone}`, weight: p.games + (phone ? 10 : 0) });
  }

  const sent = new Map<string, number>();
  for (const g of gifts) {
    const to = /^to:(\S+)/.exec(String(g.note))?.[1];
    if (to) sent.set(`${g.user} ${to}`, (sent.get(`${g.user} ${to}`) ?? 0) + 1);
  }
  for (const [key, n] of sent) {
    const [from, to] = key.split(" ");
    const phone = samePhone(from, to);
    if (n >= 5 || (phone && n >= 2)) {
      flags.push({ kind: "gifts", players: [who(from), who(to)], why: `${n} gifts from the first to the second${phone ? ", on the same phone" : ""}`, weight: n + (phone ? 10 : 0) });
    }
  }

  for (const u of users) {
    for (const [game, s] of Object.entries((u.stats?.byGame ?? {}) as Record<string, { games?: number; wins?: number }>)) {
      const games = Number(s?.games) || 0, wins = Number(s?.wins) || 0;
      if (games >= 30 && wins / games >= 0.9) flags.push({ kind: "wins", players: [who(u.id)], why: `${game}: won ${wins} of ${games}`, weight: games / 10 });
    }
  }
  return { flags: flags.sort((a, b) => b.weight - a.weight).slice(0, 200).map(({ weight: _, ...f }) => f) };
}

// ---- notifications to some players, scheduled announcements ----

/** Who a targeted notification goes to: not seen for [inactiveDays] or more, a language, levels, VIPs, older apps. */
export type Segment = { inactiveDays?: number; lang?: string; minLevel?: number; maxLevel?: number; vip?: string; belowBuild?: number };

const buildOf = (version: unknown) => Number(/\+(\d+)$/.exec(String(version ?? ""))?.[1] ?? /(\d+)$/.exec(String(version ?? ""))?.[1]) || 0;

async function segmentUsers(s: Segment) {
  const client = await db();
  const filters: string[] = [];
  if (Number(s.inactiveDays) > 0) filters.push(client.filter("lastSeen != '' && lastSeen <= {:day}", { day: dzDay(Date.now() - Number(s.inactiveDays) * DAY_MS) }));
  if (s.lang === "ar" || s.lang === "en" || s.lang === "fr") filters.push(client.filter("lang = {:lang}", { lang: s.lang }));
  if (Number(s.minLevel) > 1) filters.push(client.filter("xp >= {:xp}", { xp: 100 * (Number(s.minLevel) - 1) ** 2 }));
  if (Number(s.maxLevel) > 0) filters.push(client.filter("xp < {:xp}", { xp: 100 * Number(s.maxLevel) ** 2 }));
  if (s.vip === "vip") filters.push("vip = true");
  if (s.vip === "pro") filters.push("vipPro = true");
  if (s.vip === "none") filters.push("vip != true");
  const users = await client.collection("users").getFullList({ filter: filters.join(" && "), fields: "id,appVersion,pushTokens", batch: 2000 });
  return users.filter((u) => !(Number(s.belowBuild) > 0) || buildOf(u.appVersion) < Number(s.belowBuild));
}

/** How many a segment reaches ([send]: and the notification sent to their phones). */
export async function pushSegment(segment: Segment, title: string, body: string, send: boolean) {
  const users = await segmentUsers(segment);
  const reachable = users.filter((u) => Array.isArray(u.pushTokens) && u.pushTokens.length > 0);
  if (send) {
    if (!title.trim() || !body.trim()) throw new Error("a title and a text");
    void pushToUsers(reachable.map((u) => u.id), { sender: "support", title: title.trim().slice(0, 80), body: body.trim().slice(0, 300) })
      .catch((e) => console.error("targeted push failed", e));
  }
  return { players: users.length, phones: reachable.length };
}

/** Every minute: the announcements whose time has come go out (to every phone too, with push), once. */
export async function sendScheduled() {
  const plan = currentPlans().scheduled ?? [];
  const due = plan.filter((s) => !s.sent && Date.parse(s.at) <= Date.now());
  if (due.length === 0) return;
  await savePlan("scheduled", plan.map((s) => (due.includes(s) ? { ...s, sent: true } : s))); // (marked first: sent once)
  for (const s of due) {
    await announce(s).catch((e) => console.error("scheduled announcement failed", e));
    if (s.push) {
      const all = await (await db()).collection("users").getFullList({ fields: "id,pushTokens", batch: 2000 });
      const phones = all.filter((u) => Array.isArray(u.pushTokens) && u.pushTokens.length > 0);
      void pushToUsers(phones.map((u) => u.id), { sender: "support", title: "PlayRoom", body: (s.en || s.fr || s.ar).slice(0, 300) }).catch(() => {});
    }
  }
}

let restartAt = 0;

/**
 * The owner's restart: everyone is told the server restarts in a minute, then it stops and systemd starts it again
 * (refused until RESTART_BUTTON=1 in .env says the service restarts by itself).
 */
export async function restartSoon() {
  if (process.env.RESTART_BUTTON !== "1") throw new Error("not set up on the server yet");
  if (restartAt > Date.now()) return { at: new Date(restartAt).toISOString() };
  restartAt = Date.now() + 60_000;
  await announce({
    ar: "سيُعاد تشغيل الخادم بعد دقيقة: ستتوقف لعبتك بضع ثوانٍ.",
    en: "The server restarts in a minute: your game will stop for a few seconds.",
    fr: "Le serveur redémarre dans une minute : votre partie s'arrêtera quelques secondes.",
  });
  setTimeout(() => process.exit(1), 60_000).unref();
  return { at: new Date(restartAt).toISOString() };
}

/** The game server calls this once, at start: every minute, the reports' context kept and the announcements due sent. */
export function startAdminSchedules() {
  const run = () => Promise.all([snapReports(), sendScheduled()]).catch((e) => console.error("admin schedules failed", e));
  setInterval(run, 60_000).unref();
}

// ---- the numbers: retention, versions, the server's health ----

/**
 * Of the players who joined each of the last 30 days, the share back the next day (D1), a week later (D7) and a month
 * later (D30), from daily_stats' players of each day (counted since 2026-10-15). A day not come yet counts as none.
 */
export async function retention() {
  const client = await db();
  const today = dzDay(Date.now());
  const since = Date.now() - 61 * DAY_MS;
  const [joined, days] = await Promise.all([
    client.collection("users").getFullList({ filter: client.filter("createdAt >= {:since}", { since: pbDate(since) }), fields: "id,createdAt", batch: 2000 }),
    client.collection("daily_stats").getFullList({ filter: client.filter("day >= {:day}", { day: dzDay(since) }), fields: "day,active" }),
  ]);
  const active = new Map(days.map((d) => [String(d.day), new Set<string>(Array.isArray(d.active) ? d.active : [])]));
  const cohorts = new Map<string, string[]>();
  for (const u of joined) {
    const day = dzDay(parseDate(u.createdAt));
    cohorts.set(day, [...(cohorts.get(day) ?? []), u.id]);
  }
  const back = (ids: string[], day: string, after: number) => {
    const then = dzDay(Date.parse(`${day}T12:00:00Z`) + after * DAY_MS);
    if (then >= today && after > 0) return null; // not that day yet (today counts tomorrow)
    const seen = active.get(then);
    return seen ? ids.filter((id) => seen.has(id)).length : null;
  };
  const rows = [...cohorts].sort(([a], [b]) => b.localeCompare(a)).slice(0, 30).map(([day, ids]) => ({
    day, joined: ids.length, d1: back(ids, day, 1), d7: back(ids, day, 7), d30: back(ids, day, 30),
  }));
  const average = (key: "d1" | "d7" | "d30") => {
    const known = rows.filter((r) => r[key] !== null);
    const people = known.reduce((t, r) => t + r.joined, 0);
    return people ? known.reduce((t, r) => t + (r[key] ?? 0), 0) / people : null;
  };
  return { rows, d1: average("d1"), d7: average("d7"), d30: average("d30") };
}

/** Which app versions the players run: all of them, and those seen this week. */
export async function versions() {
  const users = await (await db()).collection("users").getFullList({ fields: "appVersion,lastSeen", batch: 2000 });
  const week = dzDay(Date.now() - 7 * DAY_MS);
  const all: Record<string, number> = {}, recent: Record<string, number> = {};
  for (const u of users) {
    const v = String(u.appVersion || "?");
    all[v] = (all[v] ?? 0) + 1;
    if (String(u.lastSeen ?? "") >= week) recent[v] = (recent[v] ?? 0) + 1;
  }
  return { all, recent };
}

const started = Date.now();

/** The machine and the game server now: memory, load, disk, the database's files and backups, rooms and players. */
export async function health() {
  const dir = process.env.POCKETBASE_DIR || "/var/lib/pocketbase";
  const size = async (file: string) => (await stat(`${dir}/${file}`).catch((): null => null))?.size ?? null;
  const disk = await statfs("/").catch((): null => null);
  const rooms = await matchMaker.query({});
  let backups: { key: string; size: number; modified: string }[] = [];
  try {
    backups = (await (await db()).backups.getFullList()).sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 10);
  } catch {}
  const copies = (await readdir("/var/lib").catch(() => [] as string[])).filter((d) => d.startsWith("pocketbase.before-")).sort().slice(-3);
  return {
    uptime: { server: Math.round((Date.now() - started) / 1000), machine: Math.round(os.uptime()) },
    memory: { total: os.totalmem(), free: os.freemem(), server: process.memoryUsage().rss },
    load: os.loadavg(), cpus: os.cpus().length,
    disk: disk ? { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize } : null,
    database: { data: await size("data.db"), logs: await size("auxiliary.db") },
    backups, copies,
    rooms: rooms.filter((r) => r.name !== "presence").length,
    inRooms: rooms.filter((r) => r.name !== "presence").reduce((t, r) => t + r.clients, 0),
    online: onlineCount(),
  };
}

/** The owner backs the database up now (PocketBase's own backup, a zip kept on the machine). */
export async function backupNow() {
  const key = `admin-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.zip`;
  await (await db()).backups.create(key);
  return { key };
}

// ---- the apps' crashes ----

const crashesFrom = new Map<string, { hour: number; n: number }>(); // a phone's address → its reports this hour

/** An app's error (POST /api/crash): counted by its message, first lines of stack and version; 30 an hour per address. */
export async function recordCrash(ip: string, body: { message?: unknown; stack?: unknown; version?: unknown; uid?: unknown }) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const from = crashesFrom.get(ip);
  if (from?.hour === hour && from.n >= 30) return;
  crashesFrom.set(ip, { hour, n: from?.hour === hour ? from.n + 1 : 1 });
  if (crashesFrom.size > 5000) crashesFrom.clear();
  const message = String(body.message ?? "").slice(0, 500), stack = String(body.stack ?? "").slice(0, 4000);
  const version = String(body.version ?? "").slice(0, 20);
  if (!message) return;
  const top = stack.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n").replace(/:\d+:\d+/g, "");
  const id = createHash("sha1").update(`${message.split("\n")[0]}|${top}|${version}`).digest("hex").slice(0, 30).replace(/[^a-z0-9]/g, "");
  const client = await db();
  const last = /^[A-Za-z0-9]{1,40}$/.test(String(body.uid ?? "")) ? String(body.uid) : "";
  const found = await maybe(client.collection("crashes").getOne(id, { fields: "id" }));
  if (found) await client.collection("crashes").update(id, { "count+": 1, last });
  else await client.collection("crashes").create({ id, message, stack, version, count: 1, last });
}

export async function crashList(page: number) {
  const list = await (await db()).collection("crashes").getList(Math.max(1, page), 50, { sort: "-updated" });
  return {
    page: list.page, pages: list.totalPages,
    items: list.items.map((c) => ({ id: c.id, message: c.message, stack: c.stack, version: c.version, count: c.count, first: c.created, last: c.updated })),
  };
}

export async function deleteCrash(id: string) {
  await (await db()).collection("crashes").delete(id);
}

// ---- the games' content ----

/** Imposter's words and Mystery Item's things, with those the owner took out or added. */
export function content() {
  const s = settings();
  return {
    imposter: { categories: CATEGORIES, words: WORDS, off: s.imposterOff, added: s.imposterAdd },
    mystery: { categories: MYSTERY_CATEGORIES, items: ITEMS, off: s.mysteryOff },
    bots: s.bots,
  };
}
