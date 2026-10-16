import assert from "assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import PocketBase, { ClientResponseError } from "pocketbase";
import { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import * as accounts from "../src/accounts.js";
import { avatarIds, frameIds } from "../src/avatars.js";
import { dayKey, weekKey } from "../src/missions.js";
import { cleanMissionPlan, cleanStorePlan, cleanTiers } from "../src/plans.js";
import { appClosed, appOpened, enterRoom, leaveRoom, presenceSaved } from "../src/presence.js";
import { kickFromApp } from "../src/rooms/PresenceRoom.js";
import { importFirebase, type FirebaseExport } from "../scripts/firebaseImport.js";

/**
 * The PocketBase side, on a real PocketBase built from pocketbase/pb_migrations: its access rules, the
 * exchange of Firebase ID tokens for PocketBase ones, what the game server writes there, and the copy from
 * Firebase. Needs the pocketbase executable, so it's skipped unless POCKETBASE_BIN points to it:
 *   POCKETBASE_BIN=/path/to/pocketbase npx mocha -r tsx test/pocketbase.test.ts --exit --timeout 60000
 */
const BIN = process.env.POCKETBASE_BIN;
const MIGRATIONS = fileURLToPath(new URL("../pocketbase/pb_migrations", import.meta.url));
const PORT = 8097;
const URL_ = `http://127.0.0.1:${PORT}`;
const SUPERUSER = { email: "server@test.local", password: "server-pass-123" };
const GAME_PORT = 2574;

/**
 * Firebase Auth, stood in for: its ID tokens are "firebase:" and the account they belong to. Anything else
 * is refused, as an expired, forged or other project's token is by the real check (firebaseVerifier,
 * tested at the end on what it refuses without Google's keys).
 */
type FirebaseAccount = { uid: string; email: string; provider?: string; emailVerified?: boolean };
const firebaseToken = ({ uid, email, provider = "password", emailVerified = false }: FirebaseAccount) =>
  `firebase:${Buffer.from(JSON.stringify({ uid, email, provider, emailVerified })).toString("base64url")}`;
const firebase: accounts.VerifyToken = async (token) => {
  if (!token.startsWith("firebase:")) throw new Error("not a Firebase ID token");
  const { uid, email, provider, emailVerified } = JSON.parse(Buffer.from(token.slice(9), "base64url").toString());
  return { uid, email: String(email).toLowerCase(), provider, emailVerified };
};

describe("PocketBase", function () {
  let server: ChildProcess | undefined;
  let dir = "";
  let admin: PocketBase;
  let seq = 0;

  before(async function () {
    if (!BIN) return this.skip();
    dir = mkdtempSync(join(tmpdir(), "pb-test-"));
    execFileSync(BIN, ["migrate", "up", "--dir", dir, "--migrationsDir", MIGRATIONS], { stdio: "ignore" });
    execFileSync(BIN, ["superuser", "upsert", SUPERUSER.email, SUPERUSER.password, "--dir", dir], { stdio: "ignore" });
    // (--automigrate=false: the tests change collections, which must not write migration files into the repo)
    server = spawn(BIN, [
      "serve", "--http", `127.0.0.1:${PORT}`, "--dir", dir, "--migrationsDir", MIGRATIONS, "--automigrate=false",
    ], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${URL_}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    admin = new PocketBase(URL_);
    admin.autoCancellation(false);
    await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    accounts.connectAccounts(URL_, SUPERUSER.email, SUPERUSER.password, firebase);
  });

  after(() => {
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A player as the app holds him: [idToken], his Firebase ID token (for the game server); [token], the
   * PocketBase token it was exchanged for; [pb], a PocketBase client signed in with it.
   */
  type Player = { id: string; idToken: string; token: string; pb: PocketBase; email: string; username: string };

  /** A new player's first launch: signed up on Firebase, his ID token exchanged. No profile yet. */
  async function newcomer(account: Partial<FirebaseAccount> = {}) {
    const n = ++seq;
    const id = account.uid ?? `Fb${String(n).padStart(26, "0")}`; // 28 characters, like Firebase's uids
    const email = account.email ?? `p${n}@test.local`;
    const idToken = firebaseToken({ ...account, uid: id, email });
    const { token, record } = await accounts.exchangeToken(idToken);
    const pb = new PocketBase(URL_);
    pb.autoCancellation(false);
    pb.authStore.save(token, record);
    return { n, id, idToken, token, pb, email };
  }

  /** A player as most are: a username, a name, a free avatar (and his welcome gift already had). */
  async function player(): Promise<Player> {
    const { n, ...p } = await newcomer();
    const username = `player_${n}`;
    await accounts.updateProfile(p.idToken, { username, name: `Player_${n}`, avatar: 103 });
    await admin.collection("users").update(p.id, { welcomeGift: true });
    return { ...p, username };
  }

  async function befriend(a: Player, b: Player) {
    await admin.collection("friends").create({ user: a.id, friend: b.id });
    await admin.collection("friends").create({ user: b.id, friend: a.id });
  }

  const user = (id: string) => admin.collection("users").getOne(id);
  const refused = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e instanceof ClientResponseError && e.status >= 400);

  const result = (uid: string, won: boolean, extra: Partial<accounts.GameResult> = {}): accounts.GameResult => ({
    uid, role: "werewolf", side: "wolf", won, minutes: 10, survived: true, name: "Wolfie", avatar: 103, frame: 0, ...extra,
  });

  describe("accounts", () => {
    it("exchanges a Firebase ID token for a PocketBase token of the same player, his account made at the first", async () => {
      const uid = "ExchangeFirebaseUid000000001";
      const google = { uid, email: "Ex@Test.local", provider: "google.com", emailVerified: true };
      const before = Date.now();
      const first = await accounts.exchangeToken(firebaseToken(google));
      assert.strictEqual(first.record.id, uid);
      // Good for an hour, like his Firebase ID token: the app exchanges again then, and at each launch.
      assert.ok(Math.abs(first.expires - (before + 3600_000)) < 5_000, `${first.expires - before} ms`);
      const me = await user(uid);
      assert.deepStrictEqual(
        [me.email, me.verified, me.emailVisibility, me.username, me.name, me.coins, me.welcomeGift],
        ["ex@test.local", true, false, "", "", 0, false],
      );
      const info = await admin.collection("private_info").getOne(uid);
      assert.deepStrictEqual([info.email, info.provider, info.createdAt], ["ex@test.local", "google.com", me.createdAt]);
      // The PocketBase token is him, for what the rules let him do. Not refreshable: a refresh gives it back.
      const pb = new PocketBase(URL_);
      pb.authStore.save(first.token, first.record);
      assert.strictEqual((await pb.collection("private_info").getOne(uid)).email, "ex@test.local");
      assert.strictEqual((await pb.collection("users").authRefresh()).token, first.token);
      // His next launch: the same account, a new token. His e-mail follows Firebase's.
      await new Promise((r) => setTimeout(r, 1100)); // (tokens count whole seconds)
      const next = await accounts.exchangeToken(firebaseToken({ ...google, email: "new@test.local" }));
      assert.deepStrictEqual([next.record.id, next.expires > first.expires], [uid, true]);
      assert.deepStrictEqual([(await user(uid)).email, (await admin.collection("private_info").getOne(uid)).email], ["new@test.local", "new@test.local"]);
      // Two launches at once: one account.
      const twin = { uid: "TwinLaunchFirebaseUid0000001", email: "twin@test.local" };
      const both = await Promise.all([1, 2].map(() => accounts.exchangeToken(firebaseToken(twin))));
      assert.deepStrictEqual(both.map((x) => x.record.id), [twin.uid, twin.uid]);
      // Refused: no token, or not a Firebase ID token (a PocketBase one neither); a Firebase account without
      // an e-mail; an e-mail another account has (one deleted from Firebase but not from PocketBase).
      for (const bad of ["", "garbage", first.token]) await assert.rejects(accounts.exchangeToken(bad), accounts.AuthError);
      await assert.rejects(accounts.exchangeToken(firebaseToken({ uid: "PhoneFirebaseUid000000000001", email: "" })), accounts.AuthError);
      const taken = (e: any) => e instanceof accounts.ProfileError && e.status === 409;
      const stranger = { uid: "TakenFirebaseUid000000000001", email: "new@test.local" };
      await assert.rejects(accounts.exchangeToken(firebaseToken(stranger)), taken);
      assert.strictEqual((await admin.collection("users").getList(1, 1, { filter: `id = "${stranger.uid}"` })).totalItems, 0);
      await assert.rejects(accounts.exchangeToken(firebaseToken({ ...google, email: "twin@test.local" })), taken);
      assert.strictEqual((await user(uid)).email, "new@test.local");
    });

    it("lets nobody log in to PocketBase or sign up on it, and a player change nothing on his account", async () => {
      const methods = await new PocketBase(URL_).collection("users").listAuthMethods();
      assert.deepStrictEqual([methods.password.enabled, methods.oauth2.enabled, methods.otp.enabled, methods.mfa.enabled], [false, false, false, false]);
      const p = await player();
      const other = await player();
      // No sign-up: not as a guest, not with a player's token.
      const signUp = { email: "guest@test.local", password: "guest-pass-1", passwordConfirm: "guest-pass-1", username: "guest_1" };
      await refused(new PocketBase(URL_).collection("users").create(signUp));
      await refused(p.pb.collection("users").create(signUp));
      // Nothing on his own account: the game server writes it.
      for (const change of [
        { name: "Renamed" }, { avatar: 104 }, { coins: 5 }, { vip: true }, { welcomeGift: false }, { emailVisibility: true },
        { email: "x@test.local" }, { password: "new-pass-12", passwordConfirm: "new-pass-12" },
      ]) {
        await refused(p.pb.collection("users").update(p.id, change));
      }
      await refused(p.pb.collection("users").update(other.id, { name: "Renamed" }));
      // Profiles are visible to signed-in players, not their e-mail; not to strangers. His own e-mail, he sees.
      const seen = await p.pb.collection("users").getOne(other.id);
      assert.strictEqual(seen.username, other.username);
      assert.ok(!seen.email);
      assert.strictEqual((await p.pb.collection("users").getOne(p.id)).email, p.email);
      await refused(new PocketBase(URL_).collection("users").getOne(p.id));
      // No password login, even on an account whose password is known (a superuser set it).
      const q = await newcomer();
      await admin.collection("users").update(q.id, { password: "known-pass-1", passwordConfirm: "known-pass-1" });
      await refused(new PocketBase(URL_).collection("users").authWithPassword(q.email, "known-pass-1"));
      // He can delete his account (the app deletes his Firebase one next).
      await p.pb.collection("users").delete(p.id);
      await refused(user(p.id));
    });

    it("knows a player by his Firebase ID token, as before: his profile, or refused", async () => {
      const p = await player();
      await admin.collection("users").update(p.id, { vip: true, frame: 2 });
      assert.deepStrictEqual(await accounts.accountFor(p.idToken), { uid: p.id, name: `Player_${p.username.slice(7)}`, avatar: 103, frame: 2, vip: true, vipPro: false, roleCardDay: "" });
      for (const bad of ["", "garbage", p.token]) await assert.rejects(accounts.accountFor(bad), accounts.AuthError); // (his PocketBase token)
      // No profile: no username picked yet, or no PocketBase account at all (he never opened this version).
      const fresh = await newcomer();
      await assert.rejects(accounts.accountFor(fresh.idToken), /no profile/);
      const boss = firebaseToken({ uid: "NeverLaunchedFirebaseUid0001", email: "boss@test.local" });
      await assert.rejects(accounts.accountFor(boss), /no profile/);
      // Admins: the e-mail in their Firebase ID token, PocketBase account or not.
      process.env.ADMIN_EMAILS = `someone@else.com, ${p.email.toUpperCase()}, Boss@Test.local`;
      assert.strictEqual(await accounts.isAdmin(p.idToken), true);
      assert.strictEqual(await accounts.isAdmin(boss), true);
      assert.strictEqual(await accounts.isAdmin(fresh.idToken), false);
      assert.strictEqual(await accounts.isAdmin(p.token), false);
      assert.strictEqual(await accounts.isAdmin("garbage"), false);
      delete process.env.ADMIN_EMAILS;
    });

    it("updates a profile: the name once a day, free or owned avatars and frames, a username only once", async () => {
      const p = await player();
      await admin.collection("users").update(p.id, { avatars: [601], frames: [3] });
      const changed = await accounts.updateProfile(p.idToken, { name: "  New_Name ", avatar: 601, frame: 3 });
      assert.deepStrictEqual([changed.name, changed.avatar, changed.frame], ["New_Name", 601, 3]);
      await assert.rejects(accounts.updateProfile(p.idToken, { name: "Again" }), /too soon/);
      await accounts.updateProfile(p.idToken, { name: "New_Name", avatar: 104, frame: 0 }); // same name: not a change
      await assert.rejects(accounts.updateProfile(p.idToken, { avatar: 602 }), /avatar/);
      await assert.rejects(accounts.updateProfile(p.idToken, { frame: 4 }), /frame/);
      for (const name of ["", "Al", "x".repeat(17), "Two Words", "dash-ed", "Amélie", 12345, true, ["Bob_1"]]) {
        await assert.rejects(accounts.updateProfile(p.idToken, { name }), (e: any) => e instanceof accounts.ProfileError && e.status === 400, String(name));
      }
      await assert.rejects(accounts.updateProfile(p.idToken, { username: 12345 }), (e: any) => e.status === 400);
      // null, like a field left out, stays as it is (a client that sends every field).
      const kept = await accounts.updateProfile(p.idToken, { name: null, username: null, frame: null, avatar: 601 });
      assert.deepStrictEqual([kept.name, kept.username, kept.avatar], ["New_Name", p.username, 601]);
      await assert.rejects(accounts.updateProfile(p.idToken, { username: "other_name" }), /username set/);
      await admin.collection("users").update(p.id, { nameChangedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
      assert.strictEqual((await accounts.updateProfile(p.idToken, { name: "Third" })).name, "Third");
      // A new player's first username and name (that name isn't a change).
      const g = await newcomer({ provider: "google.com", emailVerified: true });
      await assert.rejects(accounts.updateProfile(g.idToken, { username: p.username }), /taken/);
      await assert.rejects(accounts.updateProfile(g.idToken, { username: "No Spaces" }), /username/);
      const set = await accounts.updateProfile(g.idToken, { username: "Gamer_1", name: "Gamer", avatar: 104 });
      assert.deepStrictEqual([set.username, set.name, set.nameChangedAt], ["gamer_1", "Gamer", ""]);
      await accounts.updateProfile(g.idToken, { name: "Gamer_Two" }); // his first change
      await assert.rejects(accounts.updateProfile(g.idToken, { name: "Gamer_Three" }), /too soon/);
      // Set up before any exchange: his account is made then.
      const early = firebaseToken({ uid: "ProfileFirstFirebaseUid00001", email: "early@test.local" });
      assert.strictEqual((await accounts.updateProfile(early, { username: "early_1", name: "Early" })).username, "early_1");
      assert.strictEqual((await accounts.accountFor(early)).name, "Early");
      for (const bad of ["garbage", p.token]) await assert.rejects(accounts.updateProfile(bad, { name: "Nope" }), accounts.AuthError);
    });

    it("gives each new account its welcome gift once, with its date and private info", async () => {
      const p = await newcomer();
      await accounts.giveWelcomeGifts();
      await accounts.giveWelcomeGifts();
      const me = await user(p.id);
      assert.deepStrictEqual([me.coins, me.diamonds, me.welcomeGift], [10_000, 1_000, true]);
      assert.deepStrictEqual(me.stats, { games: 0, wins: 0, losses: 0 });
      assert.ok(Math.abs(Date.parse(me.createdAt.replace(" ", "T")) - Date.now()) < 60_000, me.createdAt);
      const info = await p.pb.collection("private_info").getOne(p.id);
      assert.deepStrictEqual([info.email, info.provider, info.createdAt], [p.email, "password", me.createdAt]);
      const other = await player();
      await refused(other.pb.collection("private_info").getOne(p.id));
      await refused(p.pb.collection("private_info").update(p.id, { birthDate: "2000-01-01" }));
    });
  });

  describe("what the game server writes", () => {
    it("records game results: XP, coins, stats, missions and the week's leaderboard, none lost when they cross", async () => {
      const wolf = await player();
      const villager = await player();
      await accounts.recordResults([
        result(wolf.id, true, { name: "Wolfie", frame: 1 }),
        result(villager.id, false, { role: "seer", side: "village", survived: false, minutes: 4, name: "Seer" }),
      ]);
      const w = await user(wolf.id);
      assert.deepStrictEqual([w.xp, w.coins], [30, 30]);
      assert.deepStrictEqual(w.stats, { games: 1, wins: 1, wolfGames: 1, wolfWins: 1, minutes: 10, roles: { werewolf: { games: 1, wins: 1 } } });
      const v = await user(villager.id);
      assert.deepStrictEqual([v.xp, v.coins, v.stats.losses, v.stats.villageWins, v.stats.roles.seer], [4, 0, 1, 0, { games: 1, wins: 0 }]);
      const today = await wolf.pb.collection("missions").getOne(`${wolf.id}_${dayKey()}`);
      assert.deepStrictEqual([today.games, today.wins, today.wolfWins, today.survived, today.minutes], [1, 1, 1, 1, 10]);
      await wolf.pb.collection("missions").getOne(`${wolf.id}_${weekKey()}`);
      await refused(villager.pb.collection("missions").getOne(`${wolf.id}_${dayKey()}`)); // his own only
      const board = await villager.pb.collection("leaderboard").getFullList({ filter: `week = "${weekKey()}"`, sort: "-xp" });
      assert.deepStrictEqual(board.filter((r) => r.user === wolf.id).map((r) => [r.id, r.xp, r.name, r.frame]), [[`${wolf.id}_${weekKey()}`, 30, "Wolfie", 1]]);
      // Five games ending at once for him.
      await Promise.all(Array.from({ length: 5 }, () => accounts.recordResults([result(wolf.id, true)])));
      const after = await user(wolf.id);
      assert.deepStrictEqual([after.xp, after.coins, after.stats.games, after.stats.roles.werewolf.wins], [180, 180, 6, 6]);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${wolf.id}_${weekKey()}`)).xp, 180);
    });

    it("sells avatars and frames for what the player has, once each, never below 0", async () => {
      const p = await player();
      await assert.rejects(accounts.buyAvatar(p.idToken, 101), /funds/);
      await admin.collection("users").update(p.id, { coins: 700, diamonds: 200 });
      // Two buys at once, money for one.
      const buys = await Promise.allSettled([accounts.buyAvatar(p.idToken, 101), accounts.buyAvatar(p.idToken, 102)]);
      assert.deepStrictEqual(buys.map((b) => b.status).sort(), ["fulfilled", "rejected"]);
      const me = await user(p.id);
      assert.strictEqual(me.coins, 200);
      assert.strictEqual(me.avatars.length, 1);
      assert.strictEqual(me.avatar, me.avatars[0]);
      await assert.rejects(accounts.buyAvatar(p.idToken, me.avatar), /owned/);
      await assert.rejects(accounts.buyAvatar(p.idToken, 103), /free/);
      await assert.rejects(accounts.buyAvatar(p.idToken, 9999), /unknown/);
      assert.deepStrictEqual(await accounts.buyFrame(p.idToken, 2), { frame: 2, diamonds: 50 });
      assert.deepStrictEqual([(await user(p.id)).frames, (await user(p.id)).frame], [[2], 2]);
      for (const bad of ["garbage", p.token]) await assert.rejects(accounts.buyAvatar(bad, 101), accounts.AuthError);
      await assert.rejects(accounts.buyAvatar(firebaseToken({ uid: "NoAccountFirebaseUid00000001", email: "none@test.local" }), 101), /no profile/);
    });

    it("hands out a mission's reward once, when it's done", async () => {
      const p = await player();
      await assert.rejects(accounts.claimMission(p.idToken, "d_win1"), /not claimable/);
      await accounts.recordResults([result(p.id, true)]);
      assert.deepStrictEqual(await accounts.claimMission(p.idToken, "d_win1"), { coins: 40, xp: 20, diamonds: 0 });
      await assert.rejects(accounts.claimMission(p.idToken, "d_win1"), /not claimable/);
      await assert.rejects(accounts.claimMission(p.idToken, "nope"), /unknown/);
      await assert.rejects(accounts.claimMission(p.token, "d_win1"), accounts.AuthError);
      const me = await user(p.id);
      assert.deepStrictEqual([me.xp, me.coins], [30 + 20, 30 + 40]);
      const today = await admin.collection("missions").getOne(`${p.id}_${dayKey()}`);
      assert.deepStrictEqual([today.claimed, today.wins], [{ d_win1: true }, 1]);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${p.id}_${weekKey()}`)).xp, 50);
    });

    it("keeps presence: online with the app open, in_game in a room, offline when gone; reset at start", async () => {
      const p = await player();
      const friend = await player();
      const presence = async () => {
        await presenceSaved();
        const row = await friend.pb.collection("presence").getOne(p.id);
        return [row.state, row.game, (await user(p.id)).room];
      };
      appOpened(p.id);
      assert.deepStrictEqual(await presence(), ["online", "", ""]);
      // A friends list's presence: one request (and the same filter for a realtime subscription).
      await befriend(p, friend);
      const stranger = await player();
      const friendsOf = (q: Player) => q.pb.collection("presence").getFullList({ filter: `user.friends_via_friend.user ?= "${q.id}"` });
      assert.deepStrictEqual((await friendsOf(friend)).map((r) => [r.id, r.state]), [[p.id, "online"]]);
      assert.deepStrictEqual(await friendsOf(stranger), []);
      enterRoom(p.id, "rummy", "ROOM1");
      assert.deepStrictEqual(await presence(), ["in_game", "rummy", "ROOM1"]);
      enterRoom(p.id, "werewolf", "ROOM2");
      leaveRoom(p.id, "ROOM2");
      assert.deepStrictEqual(await presence(), ["in_game", "rummy", "ROOM1"]);
      leaveRoom(p.id, "ROOM1");
      assert.deepStrictEqual(await presence(), ["online", "", ""]);
      appClosed(p.id);
      assert.deepStrictEqual(await presence(), ["offline", "", ""]);
      await refused(p.pb.collection("presence").update(p.id, { state: "online" }));
      // A crash left him marked: the next start clears it.
      await admin.collection("presence").update(p.id, { state: "in_game", game: "ludo" });
      await admin.collection("users").update(p.id, { room: "GONE" });
      await accounts.resetPresence();
      assert.deepStrictEqual(await presence(), ["offline", "", ""]);
    });

    it("runs the admin tools: coins by username or for everyone, every avatar, VIP", async () => {
      const p = await player();
      const before = (await user(p.id)).coins;
      assert.deepStrictEqual(await accounts.grantCurrency(p.username, 100, 5), { name: `Player_${p.username.slice(7)}`, coins: before + 100, diamonds: 5 });
      await assert.rejects(accounts.grantCurrency(p.username, -1_000_000, 0));
      await assert.rejects(accounts.grantCurrency("nobody_here", 1, 1), /no player/);
      const count = await accounts.grantCurrencyToAll(1, 0, true);
      assert.strictEqual(count, (await admin.collection("users").getList(1, 1)).totalItems);
      assert.strictEqual(await accounts.grantCurrencyToAll(1, 0), count);
      assert.strictEqual((await user(p.id)).coins, before + 101);
      assert.deepStrictEqual(await accounts.grantAllAvatars(p.email), { uid: p.id, count: avatarIds.length + frameIds.length });
      const me = await user(p.id);
      assert.deepStrictEqual([me.avatars.length, me.frames.length], [avatarIds.length, frameIds.length]);
      assert.strictEqual(await accounts.setVip(p.email, "vip"), p.username);
      assert.deepStrictEqual([(await user(p.id)).vip, (await user(p.id)).vipPro], [true, false]);
      await accounts.setVip(p.username, "pro"); // a VIP Pro is a VIP too
      assert.deepStrictEqual([(await user(p.id)).vip, (await user(p.id)).vipPro], [true, true]);
      await accounts.setVip(p.username.toUpperCase(), "off");
      assert.deepStrictEqual([(await user(p.id)).vip, (await user(p.id)).vipPro], [false, false]);
    });

    it("runs the admin tools without FIREBASE_PROJECT_ID, where players are only guests", async () => {
      const p = await player();
      try {
        accounts.connectAccounts(URL_, SUPERUSER.email, SUPERUSER.password, null); // (as the scripts may run)
        assert.strictEqual(accounts.accountsEnabled, false);
        assert.strictEqual(await accounts.setVip(p.username, "vip"), p.username);
        assert.strictEqual((await accounts.grantCurrency(p.username, 5, 0)).coins, 5);
        await assert.rejects(accounts.accountFor(p.idToken), accounts.AuthError);
        await assert.rejects(accounts.exchangeToken(p.idToken), accounts.AuthError);
      } finally {
        accounts.connectAccounts(URL_, SUPERUSER.email, SUPERUSER.password, firebase);
      }
      assert.strictEqual(accounts.accountsEnabled, true);
    });
  });

  describe("friends and chat", () => {
    it("makes friends: a request, then both rows by the one who accepts; not twice, not to oneself", async () => {
      const a = await player();
      const b = await player();
      const c = await player();
      await refused(a.pb.collection("friend_requests").create({ from: a.id, to: a.id }));
      await refused(a.pb.collection("friend_requests").create({ from: b.id, to: c.id }));
      const request = await a.pb.collection("friend_requests").create({ from: a.id, to: b.id });
      assert.strictEqual((await b.pb.collection("friend_requests").getFullList()).length, 1);
      assert.strictEqual((await c.pb.collection("friend_requests").getFullList()).length, 0);
      await refused(a.pb.collection("friends").create({ user: a.id, friend: b.id })); // the requester can't
      await refused(c.pb.collection("friends").create({ user: c.id, friend: a.id })); // nor anyone without a request
      const accept = b.pb.createBatch();
      accept.collection("friends").create({ user: b.id, friend: a.id });
      accept.collection("friends").create({ user: a.id, friend: b.id });
      accept.collection("friend_requests").delete(request.id);
      await accept.send();
      assert.strictEqual((await a.pb.collection("friends").getFullList({ filter: `user = "${a.id}"` })).length, 1);
      assert.strictEqual((await c.pb.collection("friends").getFullList()).length, 0);
      await refused(a.pb.collection("friend_requests").create({ from: a.id, to: b.id })); // already friends
      await refused(b.pb.collection("friend_requests").create({ from: b.id, to: a.id }));
      assert.strictEqual(await accounts.isFriendOfAny(a.id, [c.id, b.id]), true);
      assert.strictEqual(await accounts.isFriendOfAny(a.id, [c.id]), false);
      // Unfriending: either side deletes both rows.
      for (const row of await a.pb.collection("friends").getFullList()) await a.pb.collection("friends").delete(row.id);
      assert.strictEqual(await accounts.isFriendOfAny(b.id, [a.id]), false);
    });

    it("lets friends chat, never while both are in the same game room, and lists conversations with unread counts", async () => {
      const a = await player();
      const b = await player();
      const c = await player();
      await befriend(a, b);
      const send = (from: Player, to: Player, fields: Record<string, unknown> = {}) =>
        from.pb.collection("messages").create({ from: from.id, to: to.id, text: "hello", ...fields });
      await send(a, b, { text: "hi B" });
      await refused(send(a, c)); // not friends
      await refused(send(a, b, { from: b.id })); // as someone else
      await refused(send(a, b, { firebaseAt: new Date().toISOString() }));
      // Both in the same werewolf room: no chat (anti-cheat). Different rooms, or only one in a room: fine.
      enterRoom(a.id, "werewolf", "SAME");
      enterRoom(b.id, "werewolf", "SAME");
      await presenceSaved();
      await refused(send(a, b));
      await refused(send(b, a));
      leaveRoom(b.id, "SAME");
      await presenceSaved();
      await send(b, a, { text: "back" });
      enterRoom(b.id, "rummy", "OTHER");
      await presenceSaved();
      await send(b, a, { text: "from another room" });
      leaveRoom(a.id, "SAME");
      leaveRoom(b.id, "OTHER");
      await presenceSaved();
      // Invites and voice messages.
      await refused(send(a, b, { type: "invite" }));
      await send(a, b, { type: "invite", text: "join me", roomId: "ROOMX", roomHost: "A" });
      const audio = new File([new Uint8Array(2000)], "v.m4a", { type: "audio/mp4" });
      await refused(send(a, b, { type: "voice", text: "🎤", seconds: 0, voice: audio }));
      await refused(send(a, b, { type: "voice", text: "🎤", seconds: 3 })); // no audio
      await refused(send(a, b, { text: "text with a file", voice: audio }));
      await refused(send(a, b, { type: "voice", text: "🎤", seconds: 3, wave: "12a" }));
      await refused(send(a, b, { type: "voice", text: "🎤", seconds: 3, voice: new File([new Uint8Array(614_401)], "big.m4a") }));
      const voice = await send(a, b, { type: "voice", text: "🎤 Voice message (0:03)", seconds: 3, wave: "0123456789", voice: audio });
      assert.ok(voice.voice);
      await refused(c.pb.collection("messages").getOne(voice.id));
      assert.strictEqual((await b.pb.collection("messages").getFullList()).length, 5);
      // The conversation list: one request.
      const list = async (p: Player) => (await p.pb.collection("conversations").getFullList({ filter: 'updatedAt != ""', sort: "-updatedAt" }));
      let [forB] = await list(b);
      assert.deepStrictEqual([forB.friend, forB.lastFrom, forB.lastType, forB.lastMessage, forB.unread, forB.seen], [a.id, a.id, "voice", "🎤 Voice message (0:03)", 3, false]);
      assert.deepStrictEqual((await list(a)).map((r) => [r.friend, r.unread, r.seen]), [[b.id, 2, false]]);
      assert.strictEqual((await list(c)).length, 0);
      // B reads: his unread count drops, A sees "seen". Readable by the friend, not by anyone else.
      const read = await b.pb.collection("chat_reads").create({ user: b.id, friend: a.id });
      [forB] = await list(b);
      assert.strictEqual(forB.unread, 0);
      assert.strictEqual((await list(a))[0].seen, true);
      assert.strictEqual((await a.pb.collection("chat_reads").getOne(read.id)).user, b.id);
      await refused(c.pb.collection("chat_reads").getOne(read.id));
      await refused(c.pb.collection("chat_reads").create({ user: c.id, friend: a.id })); // not his friend
      await refused(a.pb.collection("chat_reads").update(read.id, {})); // not his
      await new Promise((r) => setTimeout(r, 5));
      await send(a, b, { text: "one more" });
      assert.deepStrictEqual([(await list(b))[0].unread, (await list(a))[0].seen], [1, false]);
      await new Promise((r) => setTimeout(r, 5));
      await b.pb.collection("chat_reads").update(read.id, {}); // read again: an empty update moves `at`
      assert.deepStrictEqual([(await list(b))[0].unread, (await list(a))[0].seen], [0, true]);
      // Deleting a message for everyone: its writer turns it into a "deleted" mark, the sound gone with it.
      // Nobody else can, nothing else can be changed, and the mark stays (the other player sees one was removed).
      const gone: Record<string, unknown> = { type: "deleted", text: "-", voice: null, wave: "", seconds: 0 };
      await refused(b.pb.collection("messages").update(voice.id, gone)); // not his
      await refused(a.pb.collection("messages").update(voice.id, { text: "edited" }));
      await refused(a.pb.collection("messages").update(voice.id, { ...gone, text: "something else" }));
      await refused(a.pb.collection("messages").update(voice.id, { ...gone, to: c.id }));
      const mark = await a.pb.collection("messages").update(voice.id, gone);
      assert.deepStrictEqual([mark.type, mark.text, mark.voice, mark.wave], ["deleted", "-", "", ""]);
      await refused(a.pb.collection("messages").update(voice.id, gone)); // once
      await refused(a.pb.collection("messages").delete(voice.id));
      assert.strictEqual((await b.pb.collection("messages").getOne(voice.id)).type, "deleted");
      const oops = await send(a, b, { text: "oops" });
      await a.pb.collection("messages").update(oops.id, { type: "deleted", text: "-" });
      assert.deepStrictEqual([(await list(b))[0].lastType, (await list(b))[0].unread], ["deleted", 1]);
    });

    it("takes one report per reporter and target, never about oneself, and lets no player read them", async () => {
      const a = await player();
      const b = await player();
      const report = { target: b.id, reporter: a.id, reason: "insults", context: "in game R1" };
      await a.pb.collection("reports").create(report);
      await refused(a.pb.collection("reports").create({ ...report, reason: "spam" }));
      await refused(a.pb.collection("reports").create({ ...report, target: a.id }));
      await refused(a.pb.collection("reports").create({ ...report, reporter: b.id, target: a.id }));
      await refused(a.pb.collection("reports").create({ ...report, target: a.id, reporter: b.id }));
      await refused(b.pb.collection("reports").create({ target: a.id, reporter: b.id, reason: "rude" }));
      await refused(b.pb.collection("reports").create({ target: a.id, reporter: b.id, reason: "other", context: "x".repeat(101) }));
      await b.pb.collection("reports").create({ target: a.id, reporter: b.id, reason: "other" });
      await refused(a.pb.collection("reports").getFullList());
      assert.strictEqual((await admin.collection("reports").getFullList({ filter: `reporter = "${a.id}" || reporter = "${b.id}"` })).length, 2);
    });
  });

  describe("support (the admin app)", () => {
    const exchange = (p: Player, device?: string) => accounts.exchangeToken(p.idToken, "1.0.12", device);
    const banned = (phone: boolean, check: (e: accounts.BanError) => boolean = () => true) => (e: unknown) =>
      e instanceof accounts.BanError && e.phone === phone && check(e);

    it("bans an account for days or for good, or its phone with every account on it; lifts them all", async () => {
      const p = await player();
      await exchange(p, "phone-aaa111");
      assert.strictEqual((await user(p.id)).device, "phone-aaa111");
      await accounts.adminBan(p.id, 3, "insults", false);
      const inThreeDays = (e: accounts.BanError) => e.reason === "insults" && Date.parse(e.until.replace(" ", "T")) > Date.now() + 2.9 * 86_400_000;
      await assert.rejects(exchange(p, "phone-aaa111"), banned(false, inThreeDays));
      await assert.rejects(accounts.accountFor(p.idToken), banned(false)); // (the rooms check it too)
      // His phone as well: another account is refused on it, not on another phone.
      await accounts.adminBan(p.id, -1, "cheating", true);
      const q = await player();
      await assert.rejects(exchange(q, "phone-aaa111"), banned(true, (e) => e.until.startsWith("9999") && e.reason === "cheating"));
      await exchange(q, "phone-bbb222");
      const bans = await accounts.adminBans();
      assert.deepStrictEqual([bans.accounts.some((b) => b.uid === p.id), bans.phones.some((b) => b.uid === p.id)], [true, true]);
      assert.deepStrictEqual(await accounts.adminBan(p.id, 0, "", false), { phoneKnown: true });
      await exchange(p, "phone-aaa111");
      await exchange(q, "phone-aaa111");
      await assert.rejects(accounts.adminBan(p.id, -2, "", false), /days/);
    });

    it("sends a player messages and warnings: he reads his own and marks them read, and may change nothing else", async () => {
      const [p, other] = [await player(), await player()];
      await accounts.adminNotice(p.id, "warning", "  Mind your words  ");
      await assert.rejects(accounts.adminNotice(p.id, "shout", "x"));
      await assert.rejects(accounts.adminNotice(p.id, "message", "  "));
      const [n] = await p.pb.collection("notices").getFullList();
      assert.deepStrictEqual([n.kind, n.text, n.readAt], ["warning", "Mind your words", ""]);
      await refused(other.pb.collection("notices").getOne(n.id));
      await refused(p.pb.collection("notices").update(n.id, { text: "nothing" }));
      await refused(p.pb.collection("notices").update(n.id, { user: other.id }));
      await refused(p.pb.collection("notices").create({ user: p.id, kind: "message", text: "hi" }));
      await refused(p.pb.collection("notices").delete(n.id));
      await p.pb.collection("notices").update(n.id, { readAt: new Date().toISOString() });
      assert.ok((await admin.collection("notices").getOne(n.id)).readAt);
      assert.deepStrictEqual((await accounts.adminPlayer(p.id)).notices.map((x) => x.kind), ["warning"]);
    });

    it("lists the reported players, the most reported first, with why, by whom and how many warnings", async () => {
      const [a, b, c, d] = [await player(), await player(), await player(), await player()];
      for (const by of [a, b, c]) {
        await by.pb.collection("reports").create({ target: d.id, reporter: by.id, reason: by === c ? "spam" : "insults" });
      }
      await a.pb.collection("reports").create({ target: c.id, reporter: a.id, reason: "afk" });
      await accounts.adminNotice(d.id, "warning", "Stop");
      const list = (await accounts.adminReports()).filter((r) => [c.id, d.id].includes(r.uid));
      assert.deepStrictEqual(list.map((r) => [r.uid, r.reports, r.reasons, r.warnings]), [
        [d.id, 3, { insults: 2, spam: 1 }, 1],
        [c.id, 1, { afk: 1 }, 0],
      ]);
      const names = [a, b, c].map((p) => `Player_${p.username.slice(7)}`).sort();
      assert.deepStrictEqual((await accounts.adminPlayer(d.id)).reports.map((r) => r.by).sort(), names);
    });

    it("keeps each player's conversation with support: he writes his side, support answers, nobody else reads it", async () => {
      const [p, other] = [await player(), await player()];
      await p.pb.collection("support_messages").create({ user: p.id, text: "My coins are gone" });
      await refused(p.pb.collection("support_messages").create({ user: p.id, text: "fake", fromSupport: true }));
      await refused(p.pb.collection("support_messages").create({ user: other.id, text: "as him" }));
      const thread = async () => (await accounts.supportThreads()).filter((t) => t.uid === p.id).map((t) => [t.last, t.waiting]);
      assert.deepStrictEqual(await thread(), [["My coins are gone", true]]);
      await accounts.supportReply(p.id, "  Sent them back  ");
      assert.deepStrictEqual(await thread(), [["Sent them back", false]]);
      const mine = await p.pb.collection("support_messages").getFullList({ sort: "created" });
      assert.deepStrictEqual(mine.map((m) => [m.fromSupport, m.text]), [[false, "My coins are gone"], [true, "Sent them back"]]);
      assert.strictEqual((await other.pb.collection("support_messages").getFullList()).length, 0);
      assert.deepStrictEqual((await accounts.supportThread(p.id)).messages.map((m) => m.text), ["My coins are gone", "Sent them back"]);
    });
  });

  describe("VIP, the weekly store, the missions' plan and the ranking's prizes", () => {
    const DAY = 86_400_000;
    const at = (date: string) => Date.parse(date.replace(" ", "T"));

    it("makes a player VIP or VIP Pro for days (added to what he has) or for good; their time runs out", async () => {
      const p = await player();
      await accounts.grantVip(p.id, "vip", 7);
      let u = await user(p.id);
      assert.ok(u.vip && !u.vipPro && at(u.vipUntil) > Date.now() + 6.9 * DAY);
      await accounts.grantVip(p.id, "vip", 3); // added to the 7
      u = await user(p.id);
      assert.ok(at(u.vipUntil) > Date.now() + 9.9 * DAY);
      await accounts.grantVip(p.id, "pro", 30); // VIP Pro is VIP too: his own 10 VIP days run on after it
      u = await user(p.id);
      assert.ok(u.vip && u.vipPro && at(u.vipProUntil) > Date.now() + 29.9 * DAY && at(u.vipUntil) > Date.now() + 39.9 * DAY);
      await accounts.grantVip(p.id, "pro", null); // for good
      u = await user(p.id);
      assert.deepStrictEqual([u.vip, u.vipPro, u.vipUntil, u.vipProUntil], [true, true, "", ""]);
      await assert.rejects(accounts.grantVip(p.id, "vip", 0), /days/);
      await accounts.grantVip(p.id, "off", null);
      u = await user(p.id);
      assert.deepStrictEqual([u.vip, u.vipPro], [false, false]);
      // Time's up: the flags go off, and a VIP Pro avatar he doesn't own goes back to a free one.
      const q = await player();
      const past = "2020-01-01 00:00:00.000Z";
      await admin.collection("users").update(q.id, { vip: true, vipPro: true, vipUntil: past, vipProUntil: past, avatar: 601 });
      await accounts.savePlan("store", cleanStorePlan({ proAvatars: [601] }));
      await accounts.expireVips();
      u = await user(q.id);
      assert.deepStrictEqual([u.vip, u.vipPro, u.avatar], [false, false, 103]);
      await accounts.savePlan("store", cleanStorePlan({}));
    });

    it("sells only this week's items at the week's price; a VIP Pro wears VIP Pro's own for nothing", async () => {
      const p = await player();
      await admin.collection("users").update(p.id, { coins: 1000, diamonds: 0 });
      await accounts.savePlan("store", cleanStorePlan({
        start: weekKey(),
        weeks: [{ avatars: [301], frames: [], cards: [] }],
        prices: { avatars: { 301: { amount: 700, currency: "coins" } } },
        proAvatars: [501],
      }));
      await assert.rejects(accounts.buyAvatar(p.idToken, 302), (e: any) => e instanceof accounts.StoreError && e.message === "not on sale");
      await assert.rejects(accounts.buyAvatar(p.idToken, 501), /not on sale/); // VIP Pro's: never sold
      await accounts.buyAvatar(p.idToken, 301);
      assert.strictEqual((await user(p.id)).coins, 300);
      await assert.rejects(accounts.updateProfile(p.idToken, { avatar: 501 }), /avatar/);
      await accounts.grantVip(p.id, "pro", 1);
      await accounts.updateProfile(p.idToken, { avatar: 501 });
      assert.strictEqual((await user(p.id)).avatar, 501);
      await accounts.savePlan("store", cleanStorePlan({}));
    });

    it("pays today's planned missions (not the usual ones), and doubles a VIP's coins and XP from games", async () => {
      const p = await player();
      await accounts.savePlan("missions", cleanMissionPlan({
        daysStart: dayKey(), days: [[{ id: "m1", counter: "games", target: 1, coins: 42 }]], weeksStart: weekKey(), weeks: [],
      }));
      await accounts.recordResults([result(p.id, false)]);
      await assert.rejects(accounts.claimMission(p.idToken, "d_play3"), /unknown mission/);
      assert.deepStrictEqual(await accounts.claimMission(p.idToken, "m1"), { coins: 42, xp: 0, diamonds: 0 });
      await accounts.savePlan("missions", cleanMissionPlan({}));
      // A VIP wins double (10 minutes won: 30 XP and 30 coins, twice), his badge in the ranking.
      await accounts.grantVip(p.id, "vip", 1);
      const before = await user(p.id);
      await accounts.recordResults([result(p.id, true)]);
      const after = await user(p.id);
      assert.deepStrictEqual([after.xp - before.xp, after.coins - before.coins], [60, 60]);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${p.id}_${weekKey()}`)).vip, "vip");
    });

    it("Monday: last week's best win their prizes, each told in a message; the 1st: VIP diamonds; each once", async () => {
      const [a, b, vip] = [await player(), await player(), await player()];
      await accounts.grantVip(vip.id, "vip", 5);
      const last = weekKey(Date.now() - 7 * DAY);
      for (const [p, xp] of [[a, 900], [b, 800]] as const) {
        await admin.collection("leaderboard").create({ id: `${p.id}_${last}`, week: last, user: p.id, xp, name: "x", avatar: 103 });
      }
      await accounts.savePlan("rewards", cleanTiers([{ from: 1, to: 1, coins: 500, vipDays: 3 }, { from: 2, to: 2, diamonds: 50 }]));
      await admin.collection("admin_config").create({ id: "done", data: { rewardWeek: weekKey(Date.now() - 14 * DAY), gemsMonth: "2000-01" } });
      const before = await Promise.all([a, b, vip].map((p) => user(p.id)));
      await accounts.runSchedules();
      const after = await Promise.all([a, b, vip].map((p) => user(p.id)));
      assert.strictEqual(after[0].coins - before[0].coins, 500);
      assert.ok(after[0].vip && at(after[0].vipUntil) > Date.now() + 2.9 * DAY);
      assert.strictEqual(after[1].diamonds - before[1].diamonds, 50);
      assert.strictEqual(after[2].diamonds - before[2].diamonds, accounts.VIP_DIAMONDS);
      const [prize] = await a.pb.collection("notices").getFullList({ filter: 'kind = "reward"' });
      assert.deepStrictEqual(prize.data, { rank: 1, week: last, coins: 500, diamonds: 0, vipDays: 3 });
      assert.strictEqual((await vip.pb.collection("notices").getFullList({ filter: 'kind = "gems"' })).length, 1);
      // Once: another round gives nothing more.
      await accounts.runSchedules();
      assert.strictEqual((await user(a.id)).coins, after[0].coins);
      assert.strictEqual((await user(vip.id)).diamonds, after[2].diamonds);
      await accounts.savePlan("rewards", []);
    });
  });

  describe("rooms and HTTP", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => {
      await appConfig.listen(GAME_PORT);
      colyseus = new ColyseusTestServer(appConfig);
    });
    after(async () => colyseus && (await colyseus.shutdown()));

    const until = async (cond: () => Promise<boolean>, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!(await cond()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(await cond(), "timed out");
    };
    const state = async (p: Player) => {
      await presenceSaved();
      return (await admin.collection("presence").getOne(p.id).catch((): null => null))?.state ?? "none";
    };

    it("lets a player into a game as himself by his Firebase ID token, and refuses any other token with 4401", async () => {
      const p = await player();
      const room: any = await colyseus.createRoom("rummy", {});
      const client = await colyseus.connectTo(room, { idToken: p.idToken });
      await assert.rejects(colyseus.connectTo(room, { idToken: p.token }), /auth/); // his PocketBase token isn't one
      const seat = room.seats.find((s: any) => s.uid === p.id);
      assert.strictEqual(seat?.name, `Player_${p.username.slice(7)}`);
      await until(async () => (await state(p)) === "in_game");
      assert.deepStrictEqual([(await admin.collection("presence").getOne(p.id)).game, (await user(p.id)).room], ["rummy", room.roomId]);
      await client.leave();
      await until(async () => (await state(p)) === "offline");
      assert.strictEqual((await user(p.id)).room, "");
    });

    it("shows a player online while his app is in the presence room", async () => {
      const p = await player();
      await assert.rejects(colyseus.sdk.joinOrCreate("presence", { idToken: "garbage" }), /auth/);
      await assert.rejects(colyseus.sdk.joinOrCreate("presence", {}), /auth/);
      const app = await colyseus.sdk.joinOrCreate("presence", { idToken: p.idToken });
      await until(async () => (await state(p)) === "online");
      await app.leave();
      await until(async () => (await state(p)) === "offline");
    });

    it("refuses a banned player at the exchange (until when, why) and in the presence room, which puts him out", async () => {
      const p = await player();
      const app = await colyseus.sdk.joinOrCreate("presence", { idToken: p.idToken });
      const left = new Promise<number>((done) => app.onLeave((code) => done(code)));
      await accounts.adminBan(p.id, 7, "spam", false);
      kickFromApp(p.id);
      assert.strictEqual(await left, 4403);
      await assert.rejects(colyseus.sdk.joinOrCreate("presence", { idToken: p.idToken }), /banned/);
      const res = await fetch(`http://127.0.0.1:${GAME_PORT}/api/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: p.idToken }),
      });
      const body = await res.json();
      assert.deepStrictEqual([res.status, body.error, body.reason, body.phone], [403, "banned", "spam", false]);
      assert.ok(Date.parse(body.until.replace(" ", "T")) > Date.now() + 6.9 * 86_400_000);
      for (const path of ["/api/admin/reports", "/api/admin/bans", `/api/admin/player?uid=${p.id}`]) {
        assert.strictEqual((await fetch(`http://127.0.0.1:${GAME_PORT}${path}`, { headers: { authorization: `Bearer ${p.idToken}` } })).status, 403);
      }
    });

    it("answers the admin's store with every usual price an object (the web layer writes a shared one as text)", async () => {
      const p = await player();
      process.env.ADMIN_EMAILS = p.email;
      const res = await fetch(`http://127.0.0.1:${GAME_PORT}/api/admin/store`, { headers: { authorization: `Bearer ${p.idToken}` } });
      delete process.env.ADMIN_EMAILS;
      const text = await res.text();
      assert.strictEqual(res.status, 200);
      assert.ok(!text.includes("[Circular"), text.slice(0, 300));
      for (const price of Object.values(JSON.parse(text).defaults.avatars)) assert.strictEqual(typeof price, "object");
    });

    it("answers /api/auth/exchange and /api/profile", async () => {
      const p = await player();
      const post = (path: string, body: unknown, token?: string) =>
        fetch(`http://127.0.0.1:${GAME_PORT}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
      const exchanged = await post("/api/auth/exchange", { idToken: p.idToken });
      assert.strictEqual(exchanged.status, 200);
      const { token, expires, record } = await exchanged.json();
      assert.deepStrictEqual([record.id, record.username, expires > Date.now() + 3500_000], [p.id, p.username, true]);
      const pb = new PocketBase(URL_);
      pb.authStore.save(token, record);
      assert.strictEqual((await pb.collection("private_info").getOne(p.id)).email, p.email);
      for (const body of [{}, { idToken: "" }, { idToken: 42 }]) assert.strictEqual((await post("/api/auth/exchange", body)).status, 400);
      assert.strictEqual((await post("/api/auth/exchange", { idToken: "garbage" })).status, 401);
      assert.strictEqual((await post("/api/auth/exchange", { idToken: token })).status, 401); // a PocketBase token
      const sameEmail = firebaseToken({ uid: "SameEmailFirebaseUid00000001", email: p.email });
      assert.strictEqual((await post("/api/auth/exchange", { idToken: sameEmail })).status, 409);
      const ok = await post("/api/profile", { avatar: 104 }, p.idToken);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await ok.json()).avatar, 104);
      assert.strictEqual((await post("/api/profile", { avatar: 601 }, p.idToken)).status, 409);
      assert.strictEqual((await post("/api/profile", { name: "" }, p.idToken)).status, 400);
      assert.strictEqual((await post("/api/profile", { avatar: 104 }, "garbage")).status, 401);
      assert.strictEqual((await post("/api/profile", { avatar: 104 }, p.token)).status, 401);
      assert.strictEqual((await post("/api/profile", { avatar: 104 })).status, 400);
      assert.strictEqual((await post("/api/avatars/buy", { id: 101 }, "garbage")).status, 401);
    });
  });

  describe("moving from Firebase", () => {
    const t = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
    const A = "AnnaFirebaseUid0000000000001"; // 28 characters, like Firebase's
    const G = "GusFirebaseUid00000000000002";
    const N = "NoraFirebaseUid0000000000003"; // signed up, never made a profile
    const chatId = [A, G].sort().join("_");
    const exported = (): FirebaseExport => ({
      authUsers: [
        { uid: A, email: "Anna@Example.com", emailVerified: false, provider: "password", created: t(0) },
        { uid: G, email: "gus@example.com", emailVerified: true, provider: "google.com", created: t(1) },
        { uid: N, email: "nora@example.com", emailVerified: false, provider: "password", created: t(2) },
      ],
      users: [
        { id: A, data: {
          username: "Anna", usernameLower: "anna", name: " Anna ", avatar: 103, frame: 2, avatars: [101, 601], frames: [2],
          xp: 120, coins: 3400, diamonds: 50, rankPoints: 7, stats: { games: 9, wins: 4, losses: 5 }, room: "OLD",
          vip: true, welcomeGift: true, nameChangedAt: t(5), createdAt: t(0),
        } },
        { id: G, data: {
          username: "gus", usernameLower: "gus", name: "Gus, whose name is far too long", avatar: 104, xp: 0, coins: -5,
          diamonds: 0, rankPoints: 0, stats: { games: 0, wins: 0, losses: 0 }, nameChangedAt: t(6), createdAt: t(1),
        } },
        { id: "OrphanProfile000000000000004", data: { username: "ghost", usernameLower: "ghost" } },
      ],
      privateInfo: [{ id: A, data: { email: "anna@example.com", provider: "password", createdAt: t(0), birthDate: "1999-05-04" } }],
      missions: [{ uid: A, id: "d-2026-09-01", data: { games: 3, wins: 1, claimed: { d_play3: true } } }],
      friends: [{ uid: A, id: G, data: { since: t(3) } }, { uid: G, id: A, data: { since: t(3) } }],
      chatReads: [{ uid: G, id: A, data: { at: t(12) } }, { uid: A, id: G, data: { at: t(20) } }],
      usernames: [{ id: "anna", data: { uid: A } }, { id: "gus", data: { uid: A } }],
      friendRequests: [
        { id: `${N}_${A}`, data: { from: N, to: A, createdAt: t(4) } },
        { id: `${A}_${G}`, data: { from: A, to: G, createdAt: t(2) } }, // they're friends since
      ],
      chats: [{ id: chatId, data: { members: [A, G], lastMessage: "join me", lastFrom: A, updatedAt: t(15) } }],
      messages: [ // (not in order)
        { chatId, id: "msg3aaaaaaaaaaaaaaaa", data: { from: A, text: "join me", type: "invite", roomId: "ROOM1", roomHost: "Anna", at: t(15) } },
        { chatId, id: "msg1aaaaaaaaaaaaaaaa", data: { from: A, text: "hi Gus", at: t(10) } },
        { chatId, id: "msg2aaaaaaaaaaaaaaaa", data: { from: G, text: "🎤 Voice message (0:07)", type: "voice", seconds: 7, wave: "0123", at: t(11) } },
      ],
      leaderboard: [
        { week: "w-2026-08-31", id: A, data: { xp: 300, name: "Anna", avatar: 103, frame: 2 } },
        { week: "w-2026-08-31", id: G, data: { xp: 10, name: "Gus, whose name is far too long", avatar: 104, frame: 0 } },
        { week: "w-2026-09-07", id: G, data: { xp: 5, name: "🔥".repeat(17), avatar: 104, frame: 0 } }, // 17 characters
        { week: "w-2026-09-07", id: A, data: { xp: 5, name: "abcdefghijklmno🔥", avatar: 103, frame: 0 } }, // 16
      ],
      reports: [
        { id: `${G}_${A}`, data: { target: G, reporter: A, reason: "insults", context: "bad words", createdAt: t(16) } },
        { id: `${A}_${G}`, data: { target: A, reporter: G, reason: "weird", context: "", createdAt: t(17) } },
      ],
    });
    const voice = async (chat: string, id: string) => (chat === chatId && id === "msg2aaaaaaaaaaaaaaaa" ? new Uint8Array(3000).fill(7) : null);
    const quiet = () => {};

    it("checks an export without writing anything (--dry)", async () => {
      const problems = await importFirebase(null, exported(), { dry: true, log: quiet });
      assert.ok(problems.some((p) => p.includes("OrphanProfile")));
      assert.strictEqual((await admin.collection("users").getList(1, 1, { filter: `id = "${A}"` })).totalItems, 0);
    });

    it("copies accounts, profiles, friends, missions, the leaderboard, reports and chats, keeping ids and order", async () => {
      const problems = await importFirebase(admin, exported(), { voice, log: quiet });
      const anna = await user(A);
      assert.deepStrictEqual(
        [anna.email, anna.username, anna.name, anna.avatars, anna.coins, anna.vip, anna.room, anna.welcomeGift, anna.verified],
        ["anna@example.com", "anna", "Anna", [101, 601], 3400, true, "", true, false],
      );
      assert.deepStrictEqual([anna.createdAt, anna.nameChangedAt], [t(0).toISOString().replace("T", " "), t(5).toISOString().replace("T", " ")]);
      const gus = await user(G);
      assert.deepStrictEqual([gus.name, gus.coins, gus.verified], ["gus", 0, true]); // his name didn't fit
      assert.strictEqual(gus.nameChangedAt, ""); // so he may pick another at once
      const nora = await user(N);
      assert.deepStrictEqual([nora.username, nora.welcomeGift], ["", true]);
      // Nothing to log in to PocketBase with: no Google link (and a random password, with password login off).
      assert.strictEqual((await admin.collection("_externalAuths").getList(1, 1, { filter: `recordRef = "${G}"` })).totalItems, 0);
      const info = await admin.collection("private_info").getOne(A);
      assert.deepStrictEqual([info.birthDate, info.provider], ["1999-05-04", "password"]);
      assert.strictEqual((await admin.collection("private_info").getOne(G)).provider, "google.com");
      assert.strictEqual((await admin.collection("missions").getOne(`${A}_d-2026-09-01`)).games, 3);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${A}_w-2026-08-31`)).xp, 300);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${G}_w-2026-08-31`)).name, "Gus, whose name ");
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${G}_w-2026-09-07`)).name, "🔥".repeat(16));
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${A}_w-2026-09-07`)).name, "abcdefghijklmno🔥");
      assert.ok(!problems.some((p) => p.includes(`players/${A}: name`)), "a 16-character name with an emoji isn't cut");
      assert.strictEqual((await admin.collection("friends").getFullList({ filter: `user = "${A}" || user = "${G}"` })).length, 2);
      const requests = await admin.collection("friend_requests").getFullList({ filter: `to = "${A}" || to = "${G}"` });
      assert.deepStrictEqual(requests.map((r) => [r.from, r.to]), [[N, A]]);
      const reports = await admin.collection("reports").getFullList({ filter: `reporter = "${A}" || reporter = "${G}"`, sort: "created" });
      assert.deepStrictEqual(reports.map((r) => r.reason), ["insults", "other"]);
      // Messages: same ids, in their original order, the voice's audio with it.
      const messages = await admin.collection("messages").getFullList({ filter: `from = "${A}" || from = "${G}"`, sort: "created" });
      assert.deepStrictEqual(messages.map((m) => m.id), ["msg1aaaaaaaaaaaaaaaa", "msg2aaaaaaaaaaaaaaaa", "msg3aaaaaaaaaaaaaaaa"]);
      assert.ok(messages[1].voice);
      assert.deepStrictEqual([messages[2].type, messages[2].roomId, messages[2].firebaseAt], ["invite", "ROOM1", t(15).toISOString().replace("T", " ")]);
      // Gus read up to minute 12: Anna's invite (15) is unread; Anna read everything; Gus hasn't seen her invite.
      const conv = async (who: string) => (await admin.collection("conversations").getFirstListItem(`user = "${who}"`));
      assert.deepStrictEqual([(await conv(G)).unread, (await conv(G)).lastMessage, (await conv(G)).updatedAt], [1, "join me", t(15).toISOString().replace("T", " ")]);
      assert.deepStrictEqual([(await conv(A)).unread, (await conv(A)).seen], [0, false]);
      for (const expected of [
        "OrphanProfile", `users/${G}: name "Gus, whose name is far too long" isn't 3 to 16 letters, digits or _: his username "gus" instead`,
        "cut to 16 characters", `users/${A}: name " Anna " had spaces around it: "Anna"`, "coins -5 raised to 0", "usernames/gus", 'reason "weird"',
      ]) {
        assert.ok(problems.some((p) => p.includes(expected)), `missing problem: ${expected}`);
      }
      // Run again (after a failure): nothing twice.
      const lines: string[] = [];
      await importFirebase(admin, exported(), { voice, log: (l) => lines.push(l) });
      assert.ok(lines.includes("users: 0 copied, 3 already there"), lines.join("\n"));
      assert.ok(lines.includes("messages: 0 copied, 3 already there"), lines.join("\n"));
      assert.strictEqual((await admin.collection("messages").getFullList({ filter: `from = "${A}" || from = "${G}"` })).length, 3);
    });

    it("lands a copied player on his copied account at his first launch, and makes one for a later sign-up", async () => {
      const anna = { uid: A, email: "anna@example.com" }; // (Firebase still has her, logins and all)
      const { token, record } = await accounts.exchangeToken(firebaseToken(anna));
      assert.deepStrictEqual([record.id, record.username, record.coins], [A, "anna", 3400]);
      const pb = new PocketBase(URL_);
      pb.authStore.save(token, record);
      assert.deepStrictEqual((await pb.collection("friends").getFullList({ filter: `user = "${A}"` })).map((f) => f.friend), [G]);
      assert.strictEqual((await pb.collection("private_info").getOne(A)).birthDate, "1999-05-04");
      assert.strictEqual((await accounts.accountFor(firebaseToken(anna))).name, "Anna");
      await accounts.giveWelcomeGifts(); // she had hers on Firebase
      assert.strictEqual((await user(A)).coins, 3400);
      // Firebase verified her e-mail since the copy: her account follows.
      await accounts.exchangeToken(firebaseToken({ ...anna, emailVerified: true }));
      assert.strictEqual((await user(A)).verified, true);
      // Signed up on Firebase after the copy: his account is made at his first launch.
      const late = await accounts.exchangeToken(firebaseToken({ uid: "LateFirebaseUid0000000000005", email: "late@example.com" }));
      assert.deepStrictEqual([late.record.id, late.record.username], ["LateFirebaseUid0000000000005", ""]);
    });
  });
});

describe("Firebase ID tokens", () => {
  it("are checked with the project id alone, and what isn't one of its own is refused before any key is needed", async () => {
    const verify = accounts.firebaseVerifier("demo-playroom");
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: "https://securetoken.google.com/demo-playroom", aud: "demo-playroom", sub: "SomeFirebaseUid", iat: now, exp: now + 3600, auth_time: now };
    const other = { ...claims, iss: "https://securetoken.google.com/another-project", aud: "another-project" };
    const jwt = (header: object, payload: object) =>
      [header, payload].map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".") + ".c2lnbmF0dXJl";
    for (const bad of ["", "garbage", jwt({ alg: "HS256", kid: "k" }, claims), jwt({ alg: "RS256" }, claims), jwt({ alg: "RS256", kid: "k" }, other)]) {
      await assert.rejects(verify(bad), Error, bad);
    }
  });
});
