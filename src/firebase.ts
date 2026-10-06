import { existsSync, readFileSync } from "fs";
import { cert, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { AVATARS, avatarIds, PRICES } from "./avatars.js";
import { claimable, DAILY_BONUS, dayKey, MISSIONS, weekKey, type Counters } from "./missions.js";

/**
 * Firebase Admin, for player accounts: verifies the app's login tokens and writes game results.
 * Needs the service account key (service-account.json next to package.json, or the
 * FIREBASE_SERVICE_ACCOUNT env var with its JSON). Without one — tests, local bots — players
 * join as guests and nothing is recorded.
 */
function init(): App | null {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT
    ?? (existsSync("service-account.json") ? readFileSync("service-account.json", "utf8") : null);
  const testing = process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("mocha"));
  if (!json || testing) return null; // tests never touch the real project
  return initializeApp({ credential: cert(JSON.parse(json)) });
}

const app = init();
export const firebaseEnabled = app !== null;

export type Account = { uid: string; name: string; avatar: number };

/** The account behind an app's login token, with its display name and avatar. Throws if invalid. */
export async function accountFor(idToken: string): Promise<Account> {
  if (!app) throw new Error("accounts disabled");
  const { uid } = await getAuth(app).verifyIdToken(idToken);
  const profile = (await getFirestore(app).doc(`users/${uid}`).get()).data();
  if (!profile) throw new Error("no profile");
  return { uid, name: String(profile.name ?? profile.username), avatar: Number(profile.avatar) || 0 };
}

/** Whether this login token belongs to an admin: the admin app's e-mails, comma-separated in ADMIN_EMAILS (.env). */
export async function isAdmin(idToken: string): Promise<boolean> {
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  if (!app || adminEmails.size === 0) return false;
  try {
    const { email } = await getAuth(app).verifyIdToken(idToken);
    return !!email && adminEmails.has(email.toLowerCase());
  } catch {
    return false;
  }
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
};

/** Winners: 3 XP + 3 coins per minute. Losers: 1 XP per minute. */
export function rewardFor(r: GameResult) {
  return { xp: (r.won ? 3 : 1) * r.minutes, coins: r.won ? 3 * r.minutes : 0 };
}

/** Adds each player's result to his account: games, wins/losses (overall, per side, per role), XP, coins. */
export async function recordResults(results: GameResult[]) {
  if (!app || results.length === 0) return;
  const db = getFirestore(app);
  const batch = db.batch();
  for (const r of results) {
    const { xp, coins } = rewardFor(r);
    const side = r.side;
    batch.update(db.doc(`users/${r.uid}`), {
      xp: FieldValue.increment(xp),
      coins: FieldValue.increment(coins),
      "stats.games": FieldValue.increment(1),
      [`stats.${r.won ? "wins" : "losses"}`]: FieldValue.increment(1),
      [`stats.${side}Games`]: FieldValue.increment(1),
      [`stats.${side}Wins`]: FieldValue.increment(r.won ? 1 : 0),
      [`stats.roles.${r.role}.games`]: FieldValue.increment(1),
      [`stats.roles.${r.role}.wins`]: FieldValue.increment(r.won ? 1 : 0),
      "stats.minutes": FieldValue.increment(r.minutes),
    });
    // Mission progress for today and this week, and this week's leaderboard.
    const counters: Counters = {
      games: 1,
      wins: r.won ? 1 : 0,
      wolfWins: r.won && side === "wolf" ? 1 : 0,
      villageWins: r.won && side === "village" ? 1 : 0,
      survived: r.survived ? 1 : 0,
      minutes: r.minutes,
    };
    const inc = Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, FieldValue.increment(v)]));
    batch.set(db.doc(`users/${r.uid}/missions/${dayKey()}`), inc, { merge: true });
    batch.set(db.doc(`users/${r.uid}/missions/${weekKey()}`), inc, { merge: true });
    batch.set(
      db.doc(`leaderboard/${weekKey()}/players/${r.uid}`),
      { xp: FieldValue.increment(xp), name: r.name, avatar: r.avatar },
      { merge: true },
    );
  }
  await batch.commit();
}

export class ClaimError extends Error {}

export class StoreError extends Error {}

/** A first avatar for an account that owns none: one of the collection at random, free, and worn. */
export async function grantStarter(idToken: string) {
  if (!app) throw new StoreError("accounts disabled");
  const { uid } = await getAuth(app).verifyIdToken(idToken);
  const db = getFirestore(app);
  const ref = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const user = await tx.get(ref);
    if (!user.exists) throw new StoreError("no profile");
    const owned: number[] = user.get("avatars") ?? [];
    if (owned.length) return { avatar: Number(user.get("avatar")) || 0, avatars: owned };
    const id = avatarIds[Math.floor(Math.random() * avatarIds.length)];
    tx.update(ref, { avatars: [id], avatar: id });
    return { avatar: id, avatars: [id] };
  });
}

/** Buys an avatar: its price (by rarity) in coins or diamonds is taken if the player has it; then it's worn. */
export async function buyAvatar(idToken: string, id: number) {
  if (!app) throw new StoreError("accounts disabled");
  const rarity = AVATARS[id];
  if (!rarity) throw new StoreError("unknown");
  const { amount, currency } = PRICES[rarity];
  const { uid } = await getAuth(app).verifyIdToken(idToken);
  const db = getFirestore(app);
  const ref = db.doc(`users/${uid}`);
  return db.runTransaction(async (tx) => {
    const user = await tx.get(ref);
    if (!user.exists) throw new StoreError("no profile");
    const owned: number[] = user.get("avatars") ?? [];
    if (owned.includes(id)) throw new StoreError("owned");
    const have = Number(user.get(currency)) || 0;
    if (have < amount) throw new StoreError("funds");
    tx.update(ref, { [currency]: FieldValue.increment(-amount), avatars: FieldValue.arrayUnion(id), avatar: id });
    return { avatar: id, [currency]: have - amount };
  });
}

/** Admin tool (scripts/grant-avatars.ts): every avatar of the collection to the account with this email. */
export async function grantAllAvatars(email: string) {
  if (!app) throw new Error("no service account");
  const { uid } = await getAuth(app).getUserByEmail(email);
  await getFirestore(app).doc(`users/${uid}`).update({ avatars: FieldValue.arrayUnion(...avatarIds) });
  return { uid, count: avatarIds.length };
}

/**
 * Hands out a mission's reward once: checks the player's progress for the current period, marks it
 * claimed, adds coins/XP/diamonds (the XP counts for this week's leaderboard too).
 */
export async function claimMission(idToken: string, id: string) {
  if (!app) throw new ClaimError("accounts disabled");
  const { uid } = await getAuth(app).verifyIdToken(idToken);
  const mission = id === DAILY_BONUS.id ? { ...DAILY_BONUS, period: "daily" } : MISSIONS.find((m) => m.id === id);
  if (!mission) throw new ClaimError("unknown mission");
  const db = getFirestore(app);
  const progressRef = db.doc(`users/${uid}/missions/${mission.period === "daily" ? dayKey() : weekKey()}`);
  const userRef = db.doc(`users/${uid}`);
  const reward = { coins: mission.coins, xp: mission.xp, diamonds: mission.diamonds };
  await db.runTransaction(async (tx) => {
    const [progress, user] = await Promise.all([tx.get(progressRef), tx.get(userRef)]);
    if (!claimable(id, progress.data() ?? {})) throw new ClaimError("not claimable");
    tx.set(progressRef, { claimed: { [id]: true } }, { merge: true });
    tx.update(userRef, {
      coins: FieldValue.increment(reward.coins),
      xp: FieldValue.increment(reward.xp),
      diamonds: FieldValue.increment(reward.diamonds),
    });
    tx.set(
      db.doc(`leaderboard/${weekKey()}/players/${uid}`),
      { xp: FieldValue.increment(reward.xp), name: user.get("name") ?? "?", avatar: user.get("avatar") ?? 1 },
      { merge: true },
    );
  });
  return reward;
}

/**
 * The room a signed-in player is in (players and spectators), on his profile: the chat rules use it
 * to stop players in the same room from messaging each other, and invites to know where he is.
 * With [ifRoom], only clears it if he's still marked in that room (he may already be in another).
 */
export async function setRoom(uid: string, room: string, ifRoom?: string) {
  if (!app) return;
  const db = getFirestore(app);
  const ref = db.doc(`users/${uid}`);
  if (ifRoom === undefined) {
    await ref.update({ room });
    return;
  }
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).get("room") === ifRoom) tx.update(ref, { room });
  });
}

/** Whether [uid] is friends with any of [others] (friend rooms let their members' friends in). */
export async function isFriendOfAny(uid: string, others: string[]): Promise<boolean> {
  if (!app || others.length === 0) return false;
  const db = getFirestore(app);
  const docs = await db.getAll(...others.map((o) => db.doc(`users/${uid}/friends/${o}`)));
  return docs.some((d) => d.exists);
}
