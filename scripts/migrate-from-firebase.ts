/**
 * Copies everything from Firebase (Auth and Firestore) into PocketBase, when moving (README: "Moving from Firebase"):
 *   npx tsx scripts/migrate-from-firebase.ts --dry   reads Firebase, says what it would copy and what's wrong
 *   npx tsx scripts/migrate-from-firebase.ts         copies it: only what PocketBase doesn't have yet, so run
 *                                                   it again after a failure and it carries on
 * Needs the Firebase service account (service-account.json next to package.json, or the FIREBASE_SERVICE_ACCOUNT
 * env var with its JSON) and, to copy, the PocketBase superuser in .env (POCKETBASE_URL,
 * POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD). What it writes, and how: scripts/firebaseImport.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import PocketBase from "pocketbase";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";
import { importFirebase, type AuthUser, type Doc, type FirebaseExport } from "./firebaseImport.js";

try {
  process.loadEnvFile();
} catch {}

const dry = process.argv.includes("--dry");
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ?? (existsSync("service-account.json") ? readFileSync("service-account.json", "utf8") : null);
if (!serviceAccount) {
  console.error("no Firebase service account: put service-account.json next to package.json (never commit it)");
  process.exit(1);
}
const firebase = initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
const fs = getFirestore(firebase);

/** Firestore's values as plain ones: Timestamps become Dates. */
function plain(v: unknown): any {
  if (v instanceof Timestamp) return v.toDate();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}
const doc = (d: DocumentSnapshot): Doc => ({ id: d.id, data: plain(d.data() ?? {}) });

/** Every document of a top-level collection. */
async function collection(name: string) {
  return (await fs.collection(name).get()).docs.map(doc);
}

/** Every document of the [name] subcollections under [parent] (users, chats…), with its parent's id. */
async function subcollection(parent: string, name: string) {
  return (await fs.collectionGroup(name).get()).docs
    .filter((d) => d.ref.parent.parent?.parent.id === parent)
    .map((d) => ({ ...doc(d), parent: d.ref.parent.parent!.id }));
}

async function authUsers() {
  const all: AuthUser[] = [];
  let pageToken: string | undefined;
  do {
    const page = await getAuth(firebase).listUsers(1000, pageToken);
    for (const u of page.users) {
      all.push({
        uid: u.uid,
        email: u.email ?? "",
        emailVerified: u.emailVerified,
        password: u.providerData.some((p) => p.providerId === "password"),
        googleId: u.providerData.find((p) => p.providerId === "google.com")?.uid ?? null,
        created: u.metadata.creationTime ? new Date(u.metadata.creationTime) : null,
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return all;
}

console.log("reading Firebase…");
const [missions, friends, chatReads, privateDocs, messages, players] = await Promise.all([
  subcollection("users", "missions"),
  subcollection("users", "friends"),
  subcollection("users", "chatReads"),
  subcollection("users", "private"),
  subcollection("chats", "messages"),
  subcollection("leaderboard", "players"),
]);
const data: FirebaseExport = {
  authUsers: await authUsers(),
  users: await collection("users"),
  privateInfo: privateDocs.filter((d) => d.id === "info").map((d) => ({ id: d.parent, data: d.data })),
  missions: missions.map(({ parent, ...d }) => ({ ...d, uid: parent })),
  friends: friends.map(({ parent, ...d }) => ({ ...d, uid: parent })),
  chatReads: chatReads.map(({ parent, ...d }) => ({ ...d, uid: parent })),
  usernames: await collection("usernames"),
  friendRequests: await collection("friendRequests"),
  chats: await collection("chats"),
  messages: messages.map(({ parent, ...d }) => ({ ...d, chatId: parent })),
  leaderboard: players.map(({ parent, ...d }) => ({ ...d, week: parent })),
  reports: await collection("reports"),
};
console.log(
  `${data.authUsers.length} accounts, ${data.users.length} profiles, ${data.messages.length} messages, ` +
    `${data.friends.length} friends rows, ${data.missions.length} mission periods`,
);

let pb: PocketBase | null = null;
if (!dry) {
  const { POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD } = process.env;
  if (!POCKETBASE_URL || !POCKETBASE_SUPERUSER_EMAIL || !POCKETBASE_SUPERUSER_PASSWORD) {
    console.error("set POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL and POCKETBASE_SUPERUSER_PASSWORD in .env");
    process.exit(1);
  }
  pb = new PocketBase(POCKETBASE_URL);
  pb.autoCancellation(false);
  await pb.collection("_superusers").authWithPassword(POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD);
}

await importFirebase(pb, data, {
  dry,
  voice: async (chatId, id) => {
    const audio = (await fs.doc(`chats/${chatId}/voices/${id}`).get()).get("audio");
    return audio ? new Uint8Array(audio) : null; // (a Buffer)
  },
});
process.exit(0);
