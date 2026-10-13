import PocketBase, { BaseAuthStore, ClientResponseError, isTokenExpired, type RecordModel } from "pocketbase";
import { AVATARS, avatarIds, FRAMES, frameIds, FREE_AVATARS, PRICES } from "./avatars.js";
import { claimable, DAILY_BONUS, dayKey, MISSIONS, weekKey, type Counters } from "./missions.js";

/**
 * Player accounts, on our PocketBase (same VPS): checks the apps' login tokens and writes everything the
 * players can't write themselves — game results, rewards, purchases, missions, the welcome gift, where
 * each player is. The only file that talks to the database: moving to another one means rewriting it.
 * Signs in as a superuser: POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD
 * (.env). Without them — tests, local bots — players join as guests and nothing is recorded.
 */
try {
  process.loadEnvFile(); // .env next to package.json (git-ignored)
} catch {}

let pb: PocketBase | null = null;
let superuser = { email: "", password: "" };
let signingIn: Promise<unknown> | null = null;
export let accountsEnabled = false;

/** Points the server at a PocketBase and its superuser (done from .env at start; the tests use their own). */
export function connectAccounts(url: string, email: string, password: string) {
  pb = new PocketBase(url, new BaseAuthStore());
  pb.autoCancellation(false); // the server sends the same request for many players at once
  superuser = { email, password };
  signingIn = null;
  accountsEnabled = true;
}

const testing = process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("mocha"));
const { POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD } = process.env;
if (POCKETBASE_URL && POCKETBASE_SUPERUSER_EMAIL && POCKETBASE_SUPERUSER_PASSWORD && !testing) {
  connectAccounts(POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD); // tests never touch the real one
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

/** A login token PocketBase doesn't accept (expired, forged, an old app's Firebase token…). */
export class AuthError extends Error {}

/** The account behind an app's login token: PocketBase checks it. */
async function signedIn(token: string): Promise<RecordModel> {
  if (!pb) throw new AuthError("accounts disabled");
  if (!token) throw new AuthError("no token");
  try {
    const { record } = await pb.send("/api/collections/users/auth-refresh", {
      method: "POST",
      headers: { Authorization: token },
    });
    return record as RecordModel;
  } catch {
    throw new AuthError("auth");
  }
}

export type Account = { uid: string; name: string; avatar: number; frame: number; vip: boolean };

/** The account behind an app's login token, with its display name and avatar. Throws if invalid. */
export async function accountFor(idToken: string): Promise<Account> {
  const user = await signedIn(idToken);
  if (!user.username) throw new AuthError("no profile"); // a Google player who hasn't picked his username yet
  return {
    uid: user.id,
    name: String(user.name || user.username),
    avatar: Number(user.avatar) || 0,
    frame: Number(user.frame) || 0,
    vip: user.vip === true,
  };
}

/** Whether this login token belongs to an admin: the admin app's e-mails, comma-separated in ADMIN_EMAILS (.env). */
export async function isAdmin(idToken: string): Promise<boolean> {
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  if (!pb || adminEmails.size === 0) return false;
  try {
    const { email } = await signedIn(idToken);
    return !!email && adminEmails.has(String(email).toLowerCase());
  } catch {
    return false;
  }
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

/** Makes an account VIP (or not): found by its e-mail or its username. VIPs pick their own role as a werewolf host. */
export async function setVip(who: string, vip: boolean) {
  const user = await findPlayer(who);
  await (await db()).collection("users").update(user.id, { vip });
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
  const { id: uid } = await signedIn(idToken);
  return forPlayer(uid, async () => {
    const client = await db();
    const user = await client.collection("users").getOne(uid);
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

/** His gift, his account's date, and his private info (e-mail, how he signs in). Once. */
async function giveWelcomeGift(uid: string) {
  await forPlayer(uid, async () => {
    const client = await db();
    const user = await client.collection("users").getOne(uid);
    if (user.welcomeGift) return;
    const google = await client.collection("_externalAuths").getList(1, 1, {
      filter: client.filter("recordRef = {:uid} && provider = 'google'", { uid }),
      skipTotal: true,
    });
    const createdAt = user.createdAt || user.created;
    const batch = client.createBatch();
    batch.collection("users").update(uid, {
      "coins+": WELCOME_GIFT.coins,
      "diamonds+": WELCOME_GIFT.diamonds,
      welcomeGift: true,
      createdAt,
      ...(user.stats ? {} : { stats: { games: 0, wins: 0, losses: 0 } }),
    });
    batch.collection("private_info").upsert({
      id: uid, user: uid, email: user.email, provider: google.items.length ? "google.com" : "password", createdAt,
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
  const { id: uid } = await signedIn(idToken);
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
 * none yet (a Google player setting up his account; that first name doesn't count as a change).
 */
export async function updateProfile(idToken: string, changes: ProfileChanges) {
  if (!pb) throw new ProfileError("accounts disabled", 409);
  const { id: uid } = await signedIn(idToken);
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

/** For the legacy login: the account with this e-mail, and whether its password still has to come from Firebase. */
export async function accountByEmail(email: string): Promise<{ id: string; legacyAuth: boolean } | null> {
  const client = await db();
  const user = await maybe(client.collection("users").getFirstListItem(client.filter("email = {:email}", { email })));
  return user && { id: user.id, legacyAuth: user.legacyAuth === true };
}

/**
 * For the legacy login: gives a Firebase player's account (his Firebase uid) the password he just proved
 * with Firebase, once. False if it already has its own. No account yet (he signed up after the copy):
 * one is made, empty, for him to set up.
 */
export async function moveFromFirebase(uid: string, email: string, password: string): Promise<boolean> {
  return forPlayer(uid, async () => {
    const client = await db();
    const user = await maybe(client.collection("users").getOne(uid));
    if (user && !user.legacyAuth) return false;
    const login = { email, password, passwordConfirm: password, legacyAuth: false };
    if (user) {
      await client.collection("users").update(uid, login);
      return true;
    }
    const createdAt = new Date().toISOString();
    const batch = client.createBatch();
    batch.collection("users").create({ id: uid, ...login, welcomeGift: true, createdAt }); // a Firebase player had his gift
    batch.collection("private_info").create({ id: uid, user: uid, email, provider: "password", createdAt });
    await batch.send();
    return true;
  });
}
