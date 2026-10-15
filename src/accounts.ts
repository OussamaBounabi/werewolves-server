import { randomBytes } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import PocketBase, { BaseAuthStore, ClientResponseError, getTokenPayload, isTokenExpired, type RecordModel } from "pocketbase";
import { AVATARS, avatarIds, FRAMES, frameIds, FREE_AVATARS, PRICES } from "./avatars.js";
import { claimable, DAILY_BONUS, dayKey, MISSIONS, weekKey, type Counters } from "./missions.js";

/**
 * Player accounts. Players log in with Firebase Auth, as before: the server checks their Firebase ID
 * tokens (firebase-admin with the project id only: no service account). Their data lives on our
 * PocketBase (same VPS), which this server reads and writes as a superuser: game results, rewards,
 * purchases, missions, the welcome gift, where each player is. The only file that talks to the database:
 * moving to another one means rewriting it.
 * Needs POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD, and FIREBASE_PROJECT_ID
 * to know the players (.env). Without them (tests, local bots) players join as guests and nothing is recorded.
 */
try {
  process.loadEnvFile(); // .env next to package.json (git-ignored)
} catch {}

/** Who a Firebase ID token belongs to. */
export type FirebaseUser = { uid: string; email: string; emailVerified: boolean; provider: string };
/** Checks a Firebase ID token (signature, project, expiry): who it belongs to, or it throws. */
export type VerifyToken = (idToken: string) => Promise<FirebaseUser>;

/** The real check, with Google's public keys (fetched and cached by firebase-admin). */
export function firebaseVerifier(projectId: string): VerifyToken {
  const auth = getAuth(initializeApp({ projectId }, `accounts-${projectId}`));
  return async (idToken) => {
    const token = await auth.verifyIdToken(idToken);
    return {
      uid: token.uid,
      email: String(token.email ?? "").toLowerCase(),
      emailVerified: token.email_verified === true,
      provider: String(token.firebase?.sign_in_provider ?? ""),
    };
  };
}

let pb: PocketBase | null = null;
let superuser = { email: "", password: "" };
let signingIn: Promise<unknown> | null = null;
let verifyToken: VerifyToken = async () => {
  throw new Error("accounts disabled");
};
export let accountsEnabled = false;

/**
 * Points the server at a PocketBase and its superuser, and at the check of Firebase ID tokens (done from
 * .env at start; the tests use their own PocketBase and a stand-in for Firebase). Without that check
 * (the admin scripts need none), players are only guests.
 */
export function connectAccounts(url: string, email: string, password: string, verify: VerifyToken | null) {
  pb = new PocketBase(url, new BaseAuthStore());
  pb.autoCancellation(false); // the server sends the same request for many players at once
  superuser = { email, password };
  signingIn = null;
  verifyToken = verify ?? (async () => {
    throw new Error("no FIREBASE_PROJECT_ID");
  });
  accountsEnabled = verify !== null;
}

const testing = process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("mocha"));
const { FIREBASE_PROJECT_ID, POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD } = process.env;
if (POCKETBASE_URL && POCKETBASE_SUPERUSER_EMAIL && POCKETBASE_SUPERUSER_PASSWORD && !testing) {
  // (tests never touch the real ones)
  const verify = FIREBASE_PROJECT_ID ? firebaseVerifier(FIREBASE_PROJECT_ID) : null;
  connectAccounts(POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD, verify);
}

/** The client, signed in as the superuser (again, when its token is about to expire). */
async function db(): Promise<PocketBase> {
  if (!pb) {
    throw new Error("no PocketBase: set POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in .env");
  }
  if (!pb.authStore.isValid || isTokenExpired(pb.authStore.token, 300)) {
    const client = pb;
    signingIn ??= client
      .collection("_superusers")
      .authWithPassword(superuser.email, superuser.password)
      .finally(() => (signingIn = null));
    await signingIn;
  }
  return pb;
}

const notFound = (e: unknown) => e instanceof ClientResponseError && e.status === 404;

/** [record], or null if there's none. */
async function maybe(record: Promise<RecordModel>): Promise<RecordModel | null> {
  try {
    return await record;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

/**
 * Runs [fn] for one player at a time. His writes read his record first (what he owns, his stats), then
 * write it back; the server is one process, so this keeps two of them from crossing.
 */
const queues = new Map<string, Promise<unknown>>();
function forPlayer<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(uid) ?? Promise.resolve()).then(fn, fn);
  const done = run.catch(() => {});
  queues.set(uid, done);
  done.then(() => queues.get(uid) === done && queues.delete(uid));
  return run;
}

/** A Firebase ID token that doesn't check out (expired, forged, another project's…), or none. */
export class AuthError extends Error {}

/** Who an app's Firebase ID token belongs to. */
async function signedIn(idToken: string): Promise<FirebaseUser> {
  if (!pb) throw new AuthError("accounts disabled");
  if (!idToken) throw new AuthError("no token");
  try {
    return await verifyToken(idToken);
  } catch {
    throw new AuthError("auth");
  }
}

export type Account = { uid: string; name: string; avatar: number; frame: number; vip: boolean; vipPro: boolean };

/** The account behind an app's Firebase ID token, with its display name and avatar. Throws if invalid. */
export async function accountFor(idToken: string): Promise<Account> {
  const { uid } = await signedIn(idToken);
  const user = await maybe((await db()).collection("users").getOne(uid));
  if (!user?.username) throw new AuthError("no profile"); // not set up yet: no username
  await checkBan(user);
  return {
    uid,
    name: String(user.name || user.username),
    avatar: Number(user.avatar) || 0,
    frame: Number(user.frame) || 0,
    vip: user.vip === true,
    vipPro: user.vipPro === true, // (a VIP Pro is a VIP too)
  };
}

/** Whether this Firebase ID token belongs to an admin: the admin app's e-mails, comma-separated in ADMIN_EMAILS (.env). */
export async function isAdmin(idToken: string): Promise<boolean> {
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  if (!pb || adminEmails.size === 0) return false;
  try {
    const { email } = await signedIn(idToken);
    return !!email && adminEmails.has(email);
  } catch {
    return false;
  }
}

/**
 * The PocketBase account of a Firebase user: found by his uid, or made for him (his first launch of the
 * app on PocketBase), with his private info. His e-mail follows Firebase's. Nobody logs in to PocketBase
 * with a password, but it wants one: a random one nobody knows.
 */
async function ensurePlayer(user: FirebaseUser): Promise<RecordModel> {
  if (!user.email) throw new AuthError("no e-mail on this Firebase account");
  return forPlayer(user.uid, async () => {
    const client = await db();
    const found = await maybe(client.collection("users").getOne(user.uid));
    if (found && found.email === user.email && found.verified === user.emailVerified) return found;
    const batch = client.createBatch();
    if (found) {
      batch.collection("users").update(user.uid, { email: user.email, verified: user.emailVerified });
      batch.collection("private_info").upsert({ id: user.uid, user: user.uid, email: user.email });
    } else {
      const password = randomBytes(24).toString("base64url");
      const createdAt = new Date().toISOString();
      const provider = ["password", "google.com"].includes(user.provider) ? user.provider : "";
      batch.collection("users").create({
        id: user.uid, email: user.email, emailVisibility: false, verified: user.emailVerified, password, passwordConfirm: password, createdAt,
      });
      batch.collection("private_info").create({ id: user.uid, user: user.uid, email: user.email, provider, createdAt });
    }
    try {
      await batch.send();
    } catch (e) {
      // Another account has this e-mail: one deleted from Firebase but not from here (README: the exchange).
      if (/"email":\{"code":"validation_not_unique"/.test(JSON.stringify((e as ClientResponseError).response ?? ""))) {
        throw new ProfileError("e-mail taken by another account", 409);
      }
      throw e;
    }
    return client.collection("users").getOne(user.uid);
  });
}

/** How long a PocketBase token from the exchange lasts: no longer than a Firebase ID token does. */
export const EXCHANGE_TOKEN_SECONDS = 60 * 60;

/**
 * POST /api/auth/exchange: an app's Firebase ID token for a PocketBase token of the same player (his
 * account is made at his first exchange), good for an hour and not refreshable: the app exchanges again
 * at each launch and when it expires. [expires] in epoch ms.
 */
export async function exchangeToken(idToken: string, appVersion?: unknown, device?: unknown) {
  const user = await signedIn(idToken);
  const account = await ensurePlayer(user);
  const phone = typeof device === "string" && DEVICE.test(device) ? device : undefined;
  await checkBan(account, phone);
  const client = await db();
  // The version of the app he opened, kept on his account: the owner sees who is still on an old one. And his
  // phone, for a ban of the phone.
  const changes: Record<string, string> = {};
  if (typeof appVersion === "string" && /^[0-9A-Za-z.+-]{1,20}$/.test(appVersion)) changes.appVersion = appVersion;
  if (phone) changes.device = phone;
  if (Object.entries(changes).some(([key, value]) => account[key] !== value)) {
    await client.collection("users").update(user.uid, changes).catch(() => {});
  }
  const { token, record } = await client.send(`/api/collections/users/impersonate/${encodeURIComponent(user.uid)}`, {
    method: "POST",
    body: { duration: EXCHANGE_TOKEN_SECONDS },
  });
  return { token: String(token), expires: Number(getTokenPayload(token).exp) * 1000, record: record as RecordModel };
}

// ---- the admin app ----

const DZ_MS = 60 * 60_000; // Algeria time (UTC+1 all year)
const dzDay = (ms: number) => new Date(ms + DZ_MS).toISOString().slice(0, 10);
const pbDate = (ms: number) => new Date(ms).toISOString().replace("T", " ");
const dayId = (day: string) => `d${day.replaceAll("-", "")}`;

/** One day's numbers (metrics.ts keeps them): games started per game, who opened the app, online every 10 minutes. */
export type DayStats = { day: string; games: Record<string, number>; active: Set<string>; online: [number, number][]; peak: number };

export async function saveDay(d: DayStats) {
  if (!pb) return;
  const batch = (await db()).createBatch();
  batch.collection("daily_stats").upsert({
    id: dayId(d.day), day: d.day, games: d.games, active: [...d.active], online: d.online, peak: d.peak,
  });
  await batch.send();
}

export async function loadDay(day: string): Promise<DayStats | null> {
  if (!pb) return null;
  const r = await maybe((await db()).collection("daily_stats").getOne(dayId(day)));
  return r ? { day: r.day, games: r.games ?? {}, active: new Set(r.active ?? []), online: r.online ?? [], peak: r.peak ?? 0 } : null;
}

/** The admin app's home: the accounts (all, VIP, VIP Pro, new today) and the last [days] days, oldest first. */
export async function adminStats(days = 30) {
  const client = await db();
  const users = client.collection("users");
  const count = async (filter: string) => (await users.getList(1, 1, { filter, fields: "id" })).totalItems;
  const today = Date.parse(`${dzDay(Date.now())}T00:00:00Z`) - DZ_MS; // this midnight in Algeria
  const since = today - (days - 1) * 86_400_000;
  const [total, vip, vipPro, newToday, joined, rows] = await Promise.all([
    count(""),
    count("vip = true"),
    count("vipPro = true"),
    count(`createdAt >= "${pbDate(today)}"`),
    users.getFullList({ filter: `createdAt >= "${pbDate(since)}"`, fields: "createdAt" }),
    client.collection("daily_stats").getFullList({ filter: `day >= "${dzDay(since)}"`, fields: "day,games,active,peak" }),
  ]);
  const signups: Record<string, number> = {};
  for (const u of joined) {
    const day = dzDay(Date.parse(String(u.createdAt).replace(" ", "T")));
    signups[day] = (signups[day] ?? 0) + 1;
  }
  const byDay = new Map(rows.map((r) => [r.day as string, r]));
  return {
    accounts: { total, vip, vipPro, today: newToday },
    days: Array.from({ length: days }, (_, i) => {
      const day = dzDay(since + i * 86_400_000);
      const r = byDay.get(day);
      return { day, signups: signups[day] ?? 0, active: (r?.active as unknown[] | undefined)?.length ?? 0, games: (r?.games ?? {}) as Record<string, number>, peak: Number(r?.peak) || 0 };
    }),
  };
}

/** The admin app's accounts, newest first, 50 a page: [query] searches the display names and usernames. */
export async function adminAccounts(query: string, page: number) {
  const client = await db();
  const q = query.trim();
  const filter = q ? client.filter("name ~ {:q} || username ~ {:q}", { q }) : "";
  const list = await client.collection("users").getList(Math.max(1, page), 50, {
    filter, sort: "-createdAt", fields: "id,name,username,avatar,frame,createdAt,vip,vipPro,xp,coins,diamonds,stats",
  });
  return {
    page: list.page,
    pages: list.totalPages,
    total: list.totalItems,
    items: list.items.map((u) => ({
      uid: u.id, name: u.name || u.username, username: u.username, avatar: Number(u.avatar) || 0, frame: Number(u.frame) || 0,
      createdAt: u.createdAt, vip: u.vip === true, vipPro: u.vipPro === true, xp: Number(u.xp) || 0,
      coins: Number(u.coins) || 0, diamonds: Number(u.diamonds) || 0, games: Number(u.stats?.games) || 0,
    })),
  };
}

/** A message from support to every player, in the three languages: the apps show the newest one, once. */
export async function announce(texts: { ar?: unknown; en?: unknown; fr?: unknown }) {
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 1000) : "");
  const message = { ar: text(texts.ar), en: text(texts.en), fr: text(texts.fr) };
  if (!message.ar && !message.en && !message.fr) throw new Error("empty");
  return (await db()).collection("announcements").create(message);
}

// ---- support (the admin app) ----

/** A banned account until [until] (year 9999: for good), or every account on a banned phone ([phone]). */
export class BanError extends AuthError {
  constructor(readonly until: string, readonly reason: string, readonly phone: boolean) {
    super("banned");
  }
}

const FOREVER = "9999-12-31 00:00:00.000Z";
const DEVICE = /^[0-9A-Za-z_-]{6,64}$/; // Android's id of the phone, for this app

/** Throws if [user] is banned, or the phone the app runs on ([device]) is. */
async function checkBan(user: RecordModel, device?: string) {
  if (parseDate(user.bannedUntil) > Date.now()) throw new BanError(String(user.bannedUntil), String(user.banReason ?? ""), false);
  if (!device) return;
  const client = await db();
  const ban = await maybe(client.collection("device_bans").getFirstListItem(client.filter("device = {:device}", { device })));
  if (ban && parseDate(ban.until) > Date.now()) throw new BanError(String(ban.until), String(ban.reason ?? ""), true);
}

const BRIEF = "id,name,username,avatar,frame,bannedUntil";

/** A player as the admin app lists him ([u] missing: a deleted account). */
const brief = (u: RecordModel | null | undefined, uid: string) => ({
  uid,
  name: String(u?.name || u?.username || "?"),
  username: String(u?.username ?? ""),
  avatar: Number(u?.avatar) || 0,
  frame: Number(u?.frame) || 0,
  bannedUntil: parseDate(u?.bannedUntil) > Date.now() ? String(u!.bannedUntil) : "",
});

/** These accounts, by id (fifty at a time: a filter has a length limit). */
async function usersById(ids: string[]) {
  const client = await db();
  const found = new Map<string, RecordModel>();
  for (let i = 0; i < ids.length; i += 50) {
    const filter = ids.slice(i, i + 50).map((id) => client.filter("id = {:id}", { id })).join(" || ");
    for (const u of await client.collection("users").getFullList({ filter, fields: BRIEF })) found.set(u.id, u);
  }
  return found;
}

/** The reported players, the most reported first: why, when last, how many warnings support sent him. */
export async function adminReports() {
  const client = await db();
  const [reports, warnings] = await Promise.all([
    client.collection("reports").getFullList({ fields: "target,reason,created", sort: "-created" }),
    client.collection("notices").getFullList({ filter: 'kind = "warning"', fields: "user" }),
  ]);
  const byPlayer = new Map<string, { reports: number; reasons: Record<string, number>; last: string }>();
  for (const r of reports) {
    const p = byPlayer.get(r.target) ?? { reports: 0, reasons: {}, last: String(r.created) };
    p.reports++;
    p.reasons[r.reason] = (p.reasons[r.reason] ?? 0) + 1;
    byPlayer.set(r.target, p);
  }
  const warned = new Map<string, number>();
  for (const w of warnings) warned.set(w.user, (warned.get(w.user) ?? 0) + 1);
  const users = await usersById([...byPlayer.keys()]);
  return [...byPlayer]
    .map(([uid, p]) => ({ ...brief(users.get(uid), uid), ...p, warnings: warned.get(uid) ?? 0 }))
    .sort((a, b) => b.reports - a.reports || b.last.localeCompare(a.last));
}

/** One player for the admin app: his account and bans, the reports against him, support's notices to him. */
export async function adminPlayer(uid: string) {
  const client = await db();
  const user = await client.collection("users").getOne(uid);
  const device = String(user.device ?? "");
  const [reports, notices, phoneBan] = await Promise.all([
    client.collection("reports").getFullList({ filter: client.filter("target = {:uid}", { uid }), sort: "-created", expand: "reporter" }),
    client.collection("notices").getFullList({ filter: client.filter("user = {:uid}", { uid }), sort: "-created" }),
    device ? maybe(client.collection("device_bans").getFirstListItem(client.filter("device = {:device}", { device }))) : null,
  ]);
  return {
    ...brief(user, uid),
    createdAt: user.createdAt,
    vip: user.vip === true,
    vipPro: user.vipPro === true,
    xp: Number(user.xp) || 0,
    games: Number(user.stats?.games) || 0,
    appVersion: String(user.appVersion ?? ""),
    banReason: parseDate(user.bannedUntil) > Date.now() ? String(user.banReason ?? "") : "",
    phoneKnown: device !== "", // (apps before 1.0.12 don't send it)
    phoneBannedUntil: phoneBan && parseDate(phoneBan.until) > Date.now() ? String(phoneBan.until) : "",
    reports: reports.map((r) => ({
      reason: r.reason, context: r.context, created: r.created, by: r.expand?.reporter?.name || r.expand?.reporter?.username || "?",
    })),
    notices: notices.map((n) => ({ kind: n.kind, text: n.text, created: n.created, readAt: n.readAt })),
  };
}

/** A message or a warning from support to one player: his app shows it until he has read it. */
export async function adminNotice(uid: string, kind: unknown, text: unknown) {
  const message = typeof text === "string" ? text.trim().slice(0, 1000) : "";
  if (!message || (kind !== "message" && kind !== "warning")) throw new Error("a message or a warning, with its text");
  await (await db()).collection("notices").create({ user: uid, kind, text: message });
}

/**
 * Bans a player for [days] (-1: for good), with [phone] the phone he last opened the app on too (every account on
 * it); 0 lifts his bans, his phone's included. [phoneKnown]: false if his app is too old to have told his phone.
 */
export async function adminBan(uid: string, days: number, reason: unknown, phone: boolean) {
  if (!Number.isInteger(days) || days < -1) throw new Error("days");
  const client = await db();
  const user = await client.collection("users").getOne(uid);
  const device = String(user.device ?? "");
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (days === 0) {
    await client.collection("users").update(uid, { bannedUntil: "", banReason: "" });
    const filter = device ? client.filter("device = {:device} || user = {:uid}", { device, uid }) : client.filter("user = {:uid}", { uid });
    for (const b of await client.collection("device_bans").getFullList({ filter })) await client.collection("device_bans").delete(b.id);
    return { phoneKnown: device !== "" };
  }
  const until = days === -1 ? FOREVER : pbDate(Date.now() + days * 86_400_000);
  await client.collection("users").update(uid, { bannedUntil: until, banReason: why });
  if (phone && device) {
    const ban = { device, until, reason: why, user: uid };
    const found = await maybe(client.collection("device_bans").getFirstListItem(client.filter("device = {:device}", { device })));
    await (found ? client.collection("device_bans").update(found.id, ban) : client.collection("device_bans").create(ban));
  }
  return { phoneKnown: device !== "" };
}

/** Who is banned now: accounts, and phones (with the account each was banned with). */
export async function adminBans() {
  const client = await db();
  const now = pbDate(Date.now());
  const [accounts, phones] = await Promise.all([
    client.collection("users").getFullList({ filter: client.filter("bannedUntil > {:now}", { now }), fields: `${BRIEF},banReason`, sort: "bannedUntil" }),
    client.collection("device_bans").getFullList({ filter: client.filter("until > {:now}", { now }), expand: "user", sort: "until" }),
  ]);
  return {
    accounts: accounts.map((u) => ({ ...brief(u, u.id), reason: String(u.banReason ?? "") })),
    phones: phones.map((b) => ({ ...brief(b.expand?.user, String(b.user)), until: String(b.until), reason: String(b.reason ?? "") })),
  };
}

/** Support's conversations, the latest first: each one's last message, and whether the player waits for an answer. */
export async function supportThreads() {
  const client = await db();
  // ponytail: the last 500 messages make the list; a view collection if support ever gets that busy
  const recent = await client.collection("support_messages").getList(1, 500, { sort: "-created", fields: "user,fromSupport,text,created" });
  const threads = new Map<string, { last: string; at: string; waiting: boolean }>();
  for (const m of recent.items) {
    if (!threads.has(m.user)) threads.set(m.user, { last: String(m.text), at: String(m.created), waiting: m.fromSupport !== true });
  }
  const users = await usersById([...threads.keys()]);
  return [...threads].map(([uid, t]) => ({ ...brief(users.get(uid), uid), ...t }));
}

/** One player's conversation with support, oldest first. */
export async function supportThread(uid: string) {
  const client = await db();
  const [user, messages] = await Promise.all([
    maybe(client.collection("users").getOne(uid, { fields: BRIEF })),
    client.collection("support_messages").getFullList({ filter: client.filter("user = {:uid}", { uid }), sort: "created", fields: "fromSupport,text,created" }),
  ]);
  return { ...brief(user, uid), messages: messages.map((m) => ({ fromSupport: m.fromSupport === true, text: m.text, created: m.created })) };
}

/** Support's answer, into the player's conversation (his app shows it). */
export async function supportReply(uid: string, text: unknown) {
  const message = typeof text === "string" ? text.trim().slice(0, 1000) : "";
  if (!message) throw new Error("empty");
  await (await db()).collection("support_messages").create({ user: uid, fromSupport: true, text: message });
}

/** The account with this e-mail, or this username (admin tools). */
async function findPlayer(who: string): Promise<RecordModel> {
  const client = await db();
  const filter = who.includes("@")
    ? client.filter("email = {:who}", { who: who.trim().toLowerCase() })
    : client.filter("username = {:who}", { who: who.trim().toLowerCase() });
  const user = await maybe(client.collection("users").getFirstListItem(filter));
  if (!user) throw new Error(`no account for ${who}`);
  return user;
}

/**
 * Makes an account VIP, VIP Pro (a VIP too, who picks his own werewolf role, host or not), or neither: found by its
 * e-mail or its username.
 */
export async function setVip(who: string, level: "vip" | "pro" | "off") {
  const user = await findPlayer(who);
  await (await db()).collection("users").update(user.id, { vip: level !== "off", vipPro: level === "pro" });
  return user.username as string;
}

export type GameResult = {
  uid: string;
  role: string;
  side: "wolf" | "village" | "solo"; // the team he ended the game on (infected players are wolves)
  won: boolean;
  minutes: number;
  survived: boolean; // alive at the end
  name: string; // for the leaderboard
  avatar: number;
  frame: number;
};

/** Winners: 3 XP + 3 coins per minute. Losers: 1 XP per minute. */
export function rewardFor(r: GameResult) {
  return { xp: (r.won ? 3 : 1) * r.minutes, coins: r.won ? 3 * r.minutes : 0 };
}

type Stats = Record<string, any>;

/** His stats after one more game: games, wins/losses (overall, per side, per role) and minutes played. */
export function addResult(stats: Stats | null | undefined, r: GameResult): Stats {
  const s: Stats = { ...(stats ?? {}) };
  const add = (key: string, n: number) => (s[key] = (Number(s[key]) || 0) + n);
  add("games", 1);
  add(r.won ? "wins" : "losses", 1);
  add(`${r.side}Games`, 1);
  add(`${r.side}Wins`, r.won ? 1 : 0);
  add("minutes", r.minutes);
  const roles = { ...(s.roles ?? {}) };
  const role = roles[r.role] ?? {};
  roles[r.role] = { games: (Number(role.games) || 0) + 1, wins: (Number(role.wins) || 0) + (r.won ? 1 : 0) };
  s.roles = roles;
  return s;
}

/** missions/leaderboard rows have fixed ids, so the server can write them without looking them up. */
const missionsId = (uid: string, period: string) => `${uid}_${period}`;
const leaderboardId = (uid: string, week: string) => `${uid}_${week}`;

/** Adds each player's result to his account: games, wins/losses (overall, per side, per role), XP, coins. */
export async function recordResults(results: GameResult[]) {
  if (!pb || results.length === 0) return;
  const failed = (await Promise.allSettled(results.map(recordResult))).find((r) => r.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

async function recordResult(r: GameResult) {
  const { xp, coins } = rewardFor(r);
  // Mission progress for today and this week, and this week's leaderboard.
  const counters: Counters = {
    games: 1,
    wins: r.won ? 1 : 0,
    wolfWins: r.won && r.side === "wolf" ? 1 : 0,
    villageWins: r.won && r.side === "village" ? 1 : 0,
    survived: r.survived ? 1 : 0,
    minutes: r.minutes,
  };
  const inc = Object.fromEntries(Object.entries(counters).map(([k, v]) => [`${k}+`, v]));
  const [day, week] = [dayKey(), weekKey()];
  await forPlayer(r.uid, async () => {
    const client = await db();
    const { stats } = await client.collection("users").getOne(r.uid, { fields: "stats" });
    const batch = client.createBatch(); // all of it or none of it
    batch.collection("users").update(r.uid, { "xp+": xp, "coins+": coins, stats: addResult(stats, r) });
    for (const period of [day, week]) {
      batch.collection("missions").upsert({ id: missionsId(r.uid, period), user: r.uid, period, ...inc });
    }
    batch.collection("leaderboard").upsert({
      id: leaderboardId(r.uid, week), week, user: r.uid, "xp+": xp, name: r.name, avatar: r.avatar, frame: r.frame,
    });
    await batch.send();
  });
}

export class ClaimError extends Error {}

export class StoreError extends Error {}

/** Buys an avatar: its price (by rarity) in coins or diamonds is taken if the player has it; then it's worn. */
export async function buyAvatar(idToken: string, id: number) {
  const rarity = AVATARS[id];
  if (!rarity) throw new StoreError("unknown");
  if (FREE_AVATARS.includes(id)) throw new StoreError("free"); // everyone has them
  return sell(idToken, id, PRICES[rarity], "avatars", "avatar");
}

/** Buys an animated frame, the same way: price taken, frame owned and worn. */
export async function buyFrame(idToken: string, id: number) {
  if (!FRAMES[id]) throw new StoreError("unknown");
  return sell(idToken, id, FRAMES[id], "frames", "frame");
}

async function sell(
  idToken: string,
  id: number,
  { amount, currency }: { amount: number; currency: "coins" | "diamonds" },
  ownedField: "avatars" | "frames",
  wornField: "avatar" | "frame",
) {
  if (!pb) throw new StoreError("accounts disabled");
  const { uid } = await signedIn(idToken);
  return forPlayer(uid, async () => {
    const client = await db();
    const user = await maybe(client.collection("users").getOne(uid));
    if (!user) throw new StoreError("no profile");
    const owned: number[] = Array.isArray(user[ownedField]) ? user[ownedField] : [];
    if (owned.includes(id)) throw new StoreError("owned");
    const have = Number(user[currency]) || 0;
    if (have < amount) throw new StoreError("funds");
    // In a batch, "coins-" can't lose a grant made at the same moment; coins can't go below 0 either.
    const batch = client.createBatch();
    batch.collection("users").update(uid, { [`${currency}-`]: amount, [ownedField]: [...owned, id], [wornField]: id });
    await batch.send();
    return { [wornField]: id, [currency]: have - amount };
  });
}

/** Admin tool (scripts/grant-avatars.ts): every avatar and frame for sale to the account with this email. */
export async function grantAllAvatars(email: string) {
  const { id: uid } = await findPlayer(email);
  await forPlayer(uid, async () => {
    const client = await db();
    const user = await client.collection("users").getOne(uid, { fields: "avatars,frames" });
    const union = (owned: unknown, all: number[]) => [...new Set([...(Array.isArray(owned) ? owned : []), ...all])];
    await client.collection("users").update(uid, { avatars: union(user.avatars, avatarIds), frames: union(user.frames, frameIds) });
  });
  return { uid, count: avatarIds.length + frameIds.length };
}

/** For now, every new player starts with a gift. Given once, soon after his account appears. */
const WELCOME_GIFT = { coins: 10_000, diamonds: 1_000 };
const WELCOME_EVERY_MS = 10_000;

/** The game server calls this once, at start: new accounts get their welcome gift (those it missed while down, too). */
export function watchNewPlayers() {
  if (!pb) return;
  const tick = () => giveWelcomeGifts().catch((e) => console.error("welcome gifts failed", e));
  tick();
  setInterval(tick, WELCOME_EVERY_MS).unref();
}

/** Every account still waiting for its welcome gift gets it (every account copied from Firebase had his). */
export async function giveWelcomeGifts() {
  const client = await db();
  const { items } = await client.collection("users").getList(1, 100, { filter: "welcomeGift = false", fields: "id", skipTotal: true });
  for (const { id } of items) await giveWelcomeGift(id);
}

/** His gift (and his account's date and empty stats, if missing). Once. */
async function giveWelcomeGift(uid: string) {
  await forPlayer(uid, async () => {
    const client = await db();
    const user = await client.collection("users").getOne(uid);
    if (user.welcomeGift) return;
    const batch = client.createBatch(); // ("coins+" in a batch: see sell)
    batch.collection("users").update(uid, {
      "coins+": WELCOME_GIFT.coins,
      "diamonds+": WELCOME_GIFT.diamonds,
      welcomeGift: true,
      createdAt: user.createdAt || user.created,
      ...(user.stats ? {} : { stats: { games: 0, wins: 0, losses: 0 } }),
    });
    await batch.send();
  });
}

/** Admin tool (scripts/grant-coins.ts): adds coins and diamonds to the account with this username. */
export async function grantCurrency(username: string, coins: number, diamonds: number) {
  if (username.includes("@")) throw new Error(`no player with the username ${username}`);
  const { id: uid } = await findPlayer(username).catch(() => {
    throw new Error(`no player with the username ${username}`);
  });
  const profile = await forPlayer(uid, async () => {
    const client = await db();
    const batch = client.createBatch();
    batch.collection("users").update(uid, { "coins+": coins, "diamonds+": diamonds });
    await batch.send(); // (fails if it would take him below 0)
    return client.collection("users").getOne(uid);
  });
  return { name: String(profile.name || profile.username), coins: Number(profile.coins), diamonds: Number(profile.diamonds) };
}

/**
 * Admin tool (scripts/grant-coins.ts --all): the same coins and diamonds to every player. Returns how many
 * accounts; with [dryRun] it only counts them.
 */
export async function grantCurrencyToAll(coins: number, diamonds: number, dryRun = false) {
  const client = await db();
  const users = await client.collection("users").getFullList({ fields: "id", batch: 1000 });
  if (dryRun) return users.length;
  for (let i = 0; i < users.length; i += 100) {
    const batch = client.createBatch(); // (100 requests at most)
    for (const { id } of users.slice(i, i + 100)) batch.collection("users").update(id, { "coins+": coins, "diamonds+": diamonds });
    await batch.send();
  }
  return users.length;
}

/**
 * Hands out a mission's reward once: checks the player's progress for the current period, marks it
 * claimed, adds coins/XP/diamonds (the XP counts for this week's leaderboard too).
 */
export async function claimMission(idToken: string, id: string) {
  if (!pb) throw new ClaimError("accounts disabled");
  const { uid } = await signedIn(idToken);
  const mission = id === DAILY_BONUS.id ? { ...DAILY_BONUS, period: "daily" } : MISSIONS.find((m) => m.id === id);
  if (!mission) throw new ClaimError("unknown mission");
  const period = mission.period === "daily" ? dayKey() : weekKey();
  const week = weekKey();
  const reward = { coins: mission.coins, xp: mission.xp, diamonds: mission.diamonds };
  await forPlayer(uid, async () => {
    const client = await db();
    const progress = await maybe(client.collection("missions").getOne(missionsId(uid, period)));
    if (!claimable(id, (progress ?? {}) as Parameters<typeof claimable>[1])) throw new ClaimError("not claimable");
    const user = await client.collection("users").getOne(uid, { fields: "name,username,avatar,frame" });
    const batch = client.createBatch();
    batch.collection("missions").upsert({
      id: missionsId(uid, period), user: uid, period, claimed: { ...(progress?.claimed ?? {}), [id]: true },
    });
    batch.collection("users").update(uid, { "coins+": reward.coins, "xp+": reward.xp, "diamonds+": reward.diamonds });
    batch.collection("leaderboard").upsert({
      id: leaderboardId(uid, week), week, user: uid, "xp+": reward.xp,
      name: user.name || user.username || "?", avatar: user.avatar ?? 0, frame: user.frame ?? 0,
    });
    await batch.send();
  });
  return reward;
}

export class ProfileError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

export type ProfileChanges = { username?: unknown; name?: unknown; avatar?: unknown; frame?: unknown };

const USERNAME = /^[a-z0-9_]{3,16}$/;
const NAME = /^[A-Za-z0-9_]{3,16}$/; // a display name: the username's characters, in any case
const NAME_EVERY_MS = 24 * 60 * 60_000;
const parseDate = (d: unknown) => (d ? Date.parse(String(d).replace(" ", "T")) : NaN);

/**
 * What a player changes on his own profile (POST /api/profile): his name (3 to 16 letters, digits or _,
 * once per 24 hours), the avatar and frame he wears (free or owned ones), and his username once, if he has
 * none yet (a new player setting up his account; that first name doesn't count as a change). His account
 * is made first if he has none yet.
 */
export async function updateProfile(idToken: string, changes: ProfileChanges) {
  if (!pb) throw new ProfileError("accounts disabled", 409);
  const firebaseUser = await signedIn(idToken);
  await ensurePlayer(firebaseUser);
  const { uid } = firebaseUser;
  return forPlayer(uid, async () => {
    const client = await db();
    const user = await client.collection("users").getOne(uid);
    const update: Record<string, unknown> = {};
    const settingUp = !user.username;
    // A field left out, or null, stays as it is. A name or a username must be text.
    const text = (value: unknown, field: string) => {
      if (typeof value !== "string") throw new ProfileError(field, 400);
      return value.trim();
    };
    if (changes.username != null) {
      const username = text(changes.username, "username").toLowerCase();
      if (!USERNAME.test(username)) throw new ProfileError("username", 400);
      if (!settingUp && username !== user.username) throw new ProfileError("username set", 409);
      if (settingUp) update.username = username;
    }
    if (changes.name != null) {
      const name = text(changes.name, "name");
      if (!NAME.test(name)) throw new ProfileError("name", 400);
      if (name !== user.name) {
        if (!settingUp && Date.now() - parseDate(user.nameChangedAt) < NAME_EVERY_MS) throw new ProfileError("too soon", 409);
        update.name = name;
        if (!settingUp) update.nameChangedAt = new Date().toISOString();
      }
    }
    if (changes.avatar != null) {
      const avatar = Number(changes.avatar);
      const mine = [...FREE_AVATARS, ...(Array.isArray(user.avatars) ? user.avatars : []), Number(user.avatar) || 0];
      if (!Number.isInteger(avatar) || !mine.includes(avatar)) throw new ProfileError("avatar", 409);
      update.avatar = avatar;
    }
    if (changes.frame != null) {
      const frame = Number(changes.frame);
      const mine = [0, ...(Array.isArray(user.frames) ? user.frames : []), Number(user.frame) || 0];
      if (!Number.isInteger(frame) || !mine.includes(frame)) throw new ProfileError("frame", 409);
      update.frame = frame;
    }
    let saved = user;
    if (Object.keys(update).length) {
      try {
        saved = await client.collection("users").update(uid, update);
      } catch (e) {
        if (e instanceof ClientResponseError && e.response?.data?.username) throw new ProfileError("username taken", 409);
        throw e;
      }
    }
    return {
      username: saved.username as string,
      name: saved.name as string,
      nameChangedAt: saved.nameChangedAt as string,
      avatar: Number(saved.avatar) || 0,
      frame: Number(saved.frame) || 0,
    };
  });
}

export type Where = { state: "online" | "in_game" | "offline"; game: string; room: string };

/** Where a player is (presence.ts decides): his presence row for his friends, users.room for the chat rule. */
export async function savePresence(uid: string, { state, game, room }: Where) {
  if (!pb) return;
  const client = await db();
  const batch = client.createBatch();
  batch.collection("presence").upsert({ id: uid, user: uid, state, game });
  batch.collection("users").update(uid, { room });
  await batch.send();
}

/** At start: nobody is connected yet, so nobody is online or in a room (a crash may have left some marked). */
export async function resetPresence() {
  if (!pb) return;
  const client = await db();
  const stale = await client.collection("presence").getFullList({ filter: 'state != "offline"', fields: "id", batch: 1000 });
  const inRooms = await client.collection("users").getFullList({ filter: 'room != ""', fields: "id", batch: 1000 });
  const writes = [
    ...stale.map(({ id }) => ["presence", id, { state: "offline", game: "" }] as const),
    ...inRooms.map(({ id }) => ["users", id, { room: "" }] as const),
  ];
  for (let i = 0; i < writes.length; i += 100) {
    const batch = client.createBatch();
    for (const [collection, id, body] of writes.slice(i, i + 100)) batch.collection(collection).update(id, body);
    await batch.send();
  }
}

/** Whether [uid] is friends with any of [others] (friend rooms let their members' friends in). */
export async function isFriendOfAny(uid: string, others: string[]): Promise<boolean> {
  if (!pb || others.length === 0) return false;
  const client = await db();
  const params: Record<string, string> = { uid };
  others.forEach((o, i) => (params[`f${i}`] = o));
  const filter = client.filter(`user = {:uid} && (${others.map((_, i) => `friend = {:f${i}}`).join(" || ")})`, params);
  const { items } = await client.collection("friends").getList(1, 1, { filter, fields: "id", skipTotal: true });
  return items.length > 0;
}
