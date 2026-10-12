import { randomBytes } from "node:crypto";
import type PocketBase from "pocketbase";

/**
 * The second half of scripts/migrate-from-firebase.ts: writes what it read from Firebase into PocketBase
 * (the collections of pocketbase/pb_migrations). Kept apart and free of Firebase so the tests can run it
 * on made-up data. It only creates what PocketBase doesn't have yet: after a failure, run it again and it
 * carries on.
 *
 * - Every Firebase Auth account becomes a PocketBase account with the same id (his uid), his profile, and a
 *   random password: an e-mail player gets his own back at his first login (legacyAuth, src/legacyLogin.ts);
 *   a Google player is linked to his Google account (_externalAuths), so signing in with Google finds it.
 * - Every migrated account counts as having had its welcome gift.
 * - Firestore's dates are kept in firebaseAt (or createdAt…). Messages and read markers are written in
 *   their original order, so PocketBase's own times sort them, and count unread ones, as Firestore did.
 * - chats/{chatId} and usernames/{name} aren't copied: the conversations view and the unique username
 *   replace them. They're only checked.
 */

/** A Firebase Auth account. */
export type AuthUser = {
  uid: string;
  email: string;
  emailVerified: boolean;
  password: boolean; // signs in with e-mail + password
  googleId: string | null; // signs in with Google: his Google account's id
  created: Date | null;
};
/** A Firestore document, Timestamps turned into Dates. */
export type Doc = { id: string; data: Record<string, any> };
export type FirebaseExport = {
  authUsers: AuthUser[];
  users: Doc[]; // users/{uid}
  privateInfo: Doc[]; // users/{uid}/private/info: id = uid
  missions: (Doc & { uid: string })[]; // users/{uid}/missions/{period}
  friends: (Doc & { uid: string })[]; // users/{uid}/friends/{fid}
  chatReads: (Doc & { uid: string })[]; // users/{uid}/chatReads/{fid}
  usernames: Doc[]; // usernames/{name}
  friendRequests: Doc[]; // friendRequests/{from_to}
  chats: Doc[]; // chats/{chatId}
  messages: (Doc & { chatId: string })[]; // chats/{chatId}/messages/{id}
  leaderboard: (Doc & { week: string })[]; // leaderboard/{week}/players/{uid}
  reports: Doc[]; // reports/{target_reporter}
};
/** A voice message's audio (chats/{chatId}/voices/{id}), read only when its message is copied. */
export type VoiceLoader = (chatId: string, messageId: string) => Promise<Uint8Array | null>;

export type ImportOptions = { dry?: boolean; voice?: VoiceLoader; log?: (line: string) => void };

const ID = /^[A-Za-z0-9]{1,36}$/; // users and messages keep their Firebase ids
const USERNAME = /^[a-z0-9_]{3,16}$/;
const PERIOD = /^[dw]-\d{4}-\d{2}-\d{2}$/;
const BIRTH_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASONS = ["cheating", "insults", "bad_name", "spam", "afk", "other"];

/** A date as PocketBase takes it ("" if none). */
function date(v: unknown): string {
  const d = v instanceof Date ? v : typeof v === "number" || typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
}
const time = (v: unknown) => (date(v) ? Date.parse(date(v)) : 0);
const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const ints = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(int))] : []);
const byTime = <T>(at: (x: T) => unknown) => (a: T, b: T) => time(at(a)) - time(at(b));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

class Report {
  counts = new Map<string, { created: number; existing: number }>();
  problems: string[] = [];
  constructor(readonly log: (line: string) => void) {}
  problem(line: string) {
    this.problems.push(line);
  }
  count(collection: string, created: number, existing: number) {
    const c = this.counts.get(collection) ?? { created: 0, existing: 0 };
    this.counts.set(collection, { created: c.created + created, existing: c.existing + existing });
  }
  print(dry: boolean) {
    for (const [name, c] of this.counts) {
      this.log(`${name}: ${c.created} ${dry ? "to copy" : "copied"}${c.existing ? `, ${c.existing} already there` : ""}`);
    }
    this.log(this.problems.length ? `${this.problems.length} problem(s):` : "no problems");
    for (const p of this.problems) this.log(`  ${p}`);
  }
}

/** Copies a Firebase export into PocketBase (with [dry], only checks it). Returns the problems found. */
export async function importFirebase(pb: PocketBase | null, data: FirebaseExport, options: ImportOptions = {}) {
  const { voice = async () => null, log = console.log } = options;
  const dry = options.dry || !pb;
  const report = new Report(log);

  /** The ids (or [key]s) a collection already has. */
  const have = async (collection: string, key: (r: any) => string = (r) => r.id, fields = "id") =>
    dry ? new Set<string>() : new Set((await pb!.collection(collection).getFullList({ fields, batch: 1000 })).map(key));

  /** Creates the records, 50 per batch; a batch that fails is retried one by one, to name the culprits. */
  async function create(collection: string, records: Record<string, any>[], existing = 0, chunk = 50) {
    report.count(collection, records.length, existing);
    if (dry) return;
    for (let i = 0; i < records.length; i += chunk) {
      const part = records.slice(i, i + chunk);
      try {
        const batch = pb!.createBatch();
        for (const r of part) batch.collection(collection).create(r);
        await batch.send();
      } catch {
        for (const r of part) await createOne(collection, r);
      }
    }
  }
  async function createOne(collection: string, record: Record<string, any>) {
    try {
      await pb!.collection(collection).create(record);
    } catch (e: any) {
      report.problem(`${collection} ${record.id ?? JSON.stringify(record).slice(0, 80)}: not copied (${JSON.stringify(e?.response?.data ?? e?.message)})`);
    }
  }

  // Accounts: every Firebase Auth account, with his profile if he made one.
  const auth = new Map(data.authUsers.map((u) => [u.uid, u]));
  const profiles = new Map(data.users.map((d) => [d.id, d.data]));
  for (const { id } of data.users) if (!auth.has(id)) report.problem(`users/${id}: no Firebase Auth account, not copied`);
  const players = new Set<string>(); // the uids PocketBase will have
  const usernames = new Set<string>();
  const accounts: Record<string, any>[] = [];
  for (const u of data.authUsers) {
    if (!ID.test(u.uid)) {
      report.problem(`auth ${u.uid}: this uid can't be a PocketBase id, not copied`);
      continue;
    }
    if (!u.email) {
      report.problem(`auth ${u.uid}: no e-mail, not copied`);
      continue;
    }
    players.add(u.uid);
    const p = profiles.get(u.uid) ?? {};
    let username = String(p.usernameLower ?? p.username ?? "").toLowerCase();
    if (username && !USERNAME.test(username)) {
      report.problem(`users/${u.uid}: username "${username}" isn't valid: left empty (he picks one in the app)`);
      username = "";
    } else if (username && usernames.has(username)) {
      report.problem(`users/${u.uid}: username "${username}" is taken by another account: left empty`);
      username = "";
    }
    if (username) usernames.add(username);
    let name = String(p.name ?? "").trim();
    if (name.length > 24) {
      report.problem(`users/${u.uid}: name "${name}" cut to 24 characters`);
      name = name.slice(0, 24);
    }
    const natural = (field: string) => {
      const n = int(p[field]);
      if (n < 0) report.problem(`users/${u.uid}: ${field} ${n} raised to 0`);
      return Math.max(0, n);
    };
    const password = randomBytes(24).toString("base64url"); // nobody knows it
    accounts.push({
      id: u.uid,
      email: u.email.toLowerCase(),
      emailVisibility: false,
      verified: u.emailVerified || !!u.googleId,
      password,
      passwordConfirm: password,
      legacyAuth: u.password, // his Firebase password comes at his first login
      username,
      name,
      nameChangedAt: date(p.nameChangedAt),
      avatar: Math.max(0, int(p.avatar)),
      frame: Math.max(0, int(p.frame)),
      avatars: ints(p.avatars),
      frames: ints(p.frames),
      xp: natural("xp"),
      coins: natural("coins"),
      diamonds: natural("diamonds"),
      rankPoints: int(p.rankPoints),
      stats: p.stats ?? { games: 0, wins: 0, losses: 0 },
      room: "",
      vip: p.vip === true,
      welcomeGift: true,
      createdAt: date(p.createdAt) || date(u.created),
    });
  }
  const knownUsers = await have("users");
  await create("users", accounts.filter((a) => !knownUsers.has(a.id)), accounts.filter((a) => knownUsers.has(a.id)).length, 20);
  const createdAt = new Map(accounts.map((a) => [a.id, a.createdAt]));

  // Google players: signing in with Google finds their account.
  const usersCollection = dry ? "" : (await pb!.collections.getOne("users")).id;
  const links = await have("_externalAuths", (l) => `${l.recordRef}/${l.provider}`, "recordRef,provider");
  const google = data.authUsers
    .filter((u) => u.googleId && players.has(u.uid))
    .map((u) => ({ collectionRef: usersCollection, recordRef: u.uid, provider: "google", providerId: u.googleId }));
  await create("_externalAuths", google.filter((l) => !links.has(`${l.recordRef}/google`)), google.filter((l) => links.has(`${l.recordRef}/google`)).length);

  // His private info, for every account (made from his Auth account if he had none).
  const infos = new Map(data.privateInfo.map((d) => [d.id, d.data]));
  const knownInfo = await have("private_info");
  const privateInfo = [...players].map((uid) => {
    const i = infos.get(uid) ?? {};
    const u = auth.get(uid)!;
    if (i.birthDate && !BIRTH_DATE.test(String(i.birthDate))) report.problem(`users/${uid}/private/info: birthDate "${i.birthDate}" isn't YYYY-MM-DD, left out`);
    return {
      id: uid,
      user: uid,
      email: String(i.email ?? u.email),
      provider: ["password", "google.com"].includes(i.provider) ? i.provider : u.password ? "password" : "google.com",
      birthDate: BIRTH_DATE.test(String(i.birthDate ?? "")) ? String(i.birthDate) : "",
      createdAt: date(i.createdAt) || createdAt.get(uid),
    };
  });
  await create("private_info", privateInfo.filter((r) => !knownInfo.has(r.id)), privateInfo.filter((r) => knownInfo.has(r.id)).length);

  // Missions and the leaderboard: fixed ids, <uid>_<period> and <uid>_<week>.
  const knownMissions = await have("missions");
  const missions: Record<string, any>[] = [];
  for (const m of data.missions) {
    if (!players.has(m.uid) || !PERIOD.test(m.id)) {
      report.problem(`users/${m.uid}/missions/${m.id}: unknown player or period, not copied`);
      continue;
    }
    const d = m.data;
    const claimed = Object.fromEntries(Object.entries(d.claimed ?? {}).filter(([, v]) => v === true));
    missions.push({
      id: `${m.uid}_${m.id}`, user: m.uid, period: m.id, claimed,
      ...Object.fromEntries(["games", "wins", "wolfWins", "villageWins", "survived", "minutes"].map((k) => [k, Math.max(0, int(d[k]))])),
    });
  }
  await create("missions", missions.filter((r) => !knownMissions.has(r.id)), missions.filter((r) => knownMissions.has(r.id)).length);

  const knownRanks = await have("leaderboard");
  const ranks: Record<string, any>[] = [];
  for (const r of data.leaderboard) {
    if (!players.has(r.id) || !/^w-\d{4}-\d{2}-\d{2}$/.test(r.week)) {
      report.problem(`leaderboard/${r.week}/players/${r.id}: unknown player or week, not copied`);
      continue;
    }
    ranks.push({
      id: `${r.id}_${r.week}`, week: r.week, user: r.id, xp: Math.max(0, int(r.data.xp)),
      name: String(r.data.name ?? "").slice(0, 24), avatar: Math.max(0, int(r.data.avatar)), frame: Math.max(0, int(r.data.frame)),
    });
  }
  await create("leaderboard", ranks.filter((r) => !knownRanks.has(r.id)), ranks.filter((r) => knownRanks.has(r.id)).length);

  // Friends (one row per side, as in Firestore), oldest first.
  const pair = (a: string, b: string) => `${a}/${b}`;
  const knownFriends = await have("friends", (f) => pair(f.user, f.friend), "user,friend");
  const friendships = new Set<string>();
  const friends: Record<string, any>[] = [];
  for (const f of [...data.friends].sort(byTime((f) => f.data.since))) {
    if (!players.has(f.uid) || !players.has(f.id) || f.uid === f.id) {
      report.problem(`users/${f.uid}/friends/${f.id}: unknown player, not copied`);
      continue;
    }
    if (friendships.has(pair(f.uid, f.id))) continue;
    friendships.add(pair(f.uid, f.id));
    friends.push({ user: f.uid, friend: f.id, firebaseAt: date(f.data.since) });
  }
  for (const key of friendships) {
    const [a, b] = key.split("/");
    if (!friendships.has(pair(b, a))) report.problem(`users/${a}/friends/${b}: ${b} doesn't list ${a} back (copied as it is)`);
  }
  await create("friends", friends.filter((f) => !knownFriends.has(pair(f.user, f.friend))), friends.filter((f) => knownFriends.has(pair(f.user, f.friend))).length);

  const knownRequests = await have("friend_requests", (r) => pair(r.from, r.to), "from,to");
  const requests: Record<string, any>[] = [];
  const asked = new Set<string>();
  for (const r of [...data.friendRequests].sort(byTime((r) => r.data.createdAt))) {
    const { from, to } = r.data;
    if (!players.has(from) || !players.has(to) || from === to) {
      report.problem(`friendRequests/${r.id}: unknown player, not copied`);
      continue;
    }
    if (friendships.has(pair(from, to)) || asked.has(pair(from, to))) continue; // already friends (or twice)
    asked.add(pair(from, to));
    requests.push({ from, to, firebaseAt: date(r.data.createdAt) });
  }
  await create("friend_requests", requests.filter((r) => !knownRequests.has(pair(r.from, r.to))), requests.filter((r) => knownRequests.has(pair(r.from, r.to))).length);

  const knownReports = await have("reports", (r) => pair(r.target, r.reporter), "target,reporter");
  const reports: Record<string, any>[] = [];
  const reported = new Set<string>();
  for (const r of [...data.reports].sort(byTime((r) => r.data.createdAt))) {
    const { target, reporter } = r.data;
    if (!players.has(target) || !players.has(reporter) || reported.has(pair(target, reporter))) {
      report.problem(`reports/${r.id}: unknown player or a second report, not copied`);
      continue;
    }
    reported.add(pair(target, reporter));
    if (!REASONS.includes(r.data.reason)) report.problem(`reports/${r.id}: reason "${r.data.reason}" saved as "other"`);
    reports.push({
      target, reporter, reason: REASONS.includes(r.data.reason) ? r.data.reason : "other",
      context: String(r.data.context ?? "").slice(0, 100), firebaseAt: date(r.data.createdAt),
    });
  }
  await create("reports", reports.filter((r) => !knownReports.has(pair(r.target, r.reporter))), reports.filter((r) => knownReports.has(pair(r.target, r.reporter))).length);

  // The chats: messages and read markers together, in their original order.
  const members = new Map(data.chats.map((c) => [c.id, (Array.isArray(c.data.members) ? c.data.members : c.id.split("_")) as string[]]));
  type Event =
    | { at: unknown; message: Record<string, any>; chatId: string }
    | { at: unknown; read: { user: string; friend: string } };
  const events: Event[] = [];
  for (const m of data.messages) {
    const d = m.data;
    const both = members.get(m.chatId) ?? m.chatId.split("_");
    const to = both.find((x) => x !== d.from);
    const text = String(d.text ?? "").slice(0, 500);
    if (!ID.test(m.id) || !both.includes(d.from) || !to || !players.has(d.from) || !players.has(to) || !text) {
      report.problem(`chats/${m.chatId}/messages/${m.id}: bad id, sender, recipient or text, not copied`);
      continue;
    }
    const type = d.type === "invite" || d.type === "voice" ? d.type : "";
    events.push({
      at: d.at,
      chatId: m.chatId,
      message: {
        id: m.id, from: d.from, to, type, text,
        roomId: type === "invite" ? String(d.roomId ?? "").slice(0, 64) : "",
        roomHost: type === "invite" ? String(d.roomHost ?? "").slice(0, 64) : "",
        seconds: type === "voice" ? Math.min(60, Math.max(0, int(d.seconds))) : 0,
        wave: type === "voice" ? String(d.wave ?? "").replace(/[^0-9]/g, "").slice(0, 64) : "",
        firebaseAt: date(d.at),
      },
    });
  }
  for (const r of data.chatReads) {
    if (!players.has(r.uid) || !players.has(r.id)) {
      report.problem(`users/${r.uid}/chatReads/${r.id}: unknown player, not copied`);
      continue;
    }
    events.push({ at: r.data.at, read: { user: r.uid, friend: r.id } });
  }
  // (A read marker comes after the messages of its own moment: it covers them.)
  events.sort((a, b) => time(a.at) - time(b.at) || Number("read" in a) - Number("read" in b));

  const knownMessages = await have("messages");
  const knownReads = await have("chat_reads", (r) => pair(r.user, r.friend), "user,friend");
  let pending: Record<string, any>[] = [];
  const flush = async () => {
    const part = pending;
    pending = [];
    if (part.length) await create("messages", part);
  };
  let oldMessages = 0, oldReads = 0;
  for (const e of events) {
    if ("message" in e) {
      if (knownMessages.has(e.message.id)) {
        oldMessages++;
        continue;
      }
      if (e.message.type !== "voice") {
        pending.push(e.message);
        if (pending.length >= 50) await flush();
        continue;
      }
      await flush();
      const audio = await voice(e.chatId, e.message.id);
      if (!audio) report.problem(`chats/${e.chatId}/voices/${e.message.id}: no audio, the message is copied without it`);
      report.count("messages", 1, 0);
      if (dry) continue;
      const file = audio ? { voice: new File([audio], `${e.message.id}.m4a`, { type: "audio/mp4" }) } : {};
      await createOne("messages", { ...e.message, ...file });
      continue;
    }
    if (knownReads.has(pair(e.read.user, e.read.friend))) {
      oldReads++;
      continue;
    }
    // Its own moment between the messages before and after it (PocketBase's times, a millisecond apart).
    await flush();
    report.count("chat_reads", 1, 0);
    if (dry) continue;
    await sleep(2);
    await createOne("chat_reads", e.read);
    await sleep(2);
  }
  await flush();
  report.count("messages", 0, oldMessages);
  report.count("chat_reads", 0, oldReads);

  // Not copied, only checked.
  const owners = new Map(accounts.map((a) => [a.username, a.id]));
  for (const u of data.usernames) {
    if (owners.get(u.id) !== u.data.uid) report.problem(`usernames/${u.id}: points to ${u.data.uid}, whose username isn't "${u.id}"`);
  }
  const chatsWithMessages = new Set(data.messages.map((m) => m.chatId));
  report.log(`chats: ${data.chats.length} conversations, ${chatsWithMessages.size} with messages (rebuilt by the conversations view)`);
  report.print(dry);
  return report.problems;
}
