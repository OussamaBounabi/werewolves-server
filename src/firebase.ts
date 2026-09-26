import { existsSync, readFileSync } from "fs";
import { cert, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

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

export type GameResult = { uid: string; role: string; won: boolean; minutes: number };

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
    const side = r.role === "werewolf" ? "wolf" : "village";
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
  }
  await batch.commit();
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
