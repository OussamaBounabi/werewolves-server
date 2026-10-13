import assert from "assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import PocketBase, { ClientResponseError } from "pocketbase";
import { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import * as accounts from "../src/accounts.js";
import { avatarIds, frameIds } from "../src/avatars.js";
import { legacyLogin, LegacyLoginError } from "../src/legacyLogin.js";
import { dayKey, weekKey } from "../src/missions.js";
import { appClosed, appOpened, enterRoom, leaveRoom, presenceSaved } from "../src/presence.js";
import { importFirebase, type FirebaseExport } from "../scripts/firebaseImport.js";

/**
 * The PocketBase side, on a real PocketBase built from pocketbase/pb_migrations: its access rules, what the
 * game server writes there, and the copy from Firebase. Needs the pocketbase executable, so it's skipped
 * unless POCKETBASE_BIN points to it:
 *   POCKETBASE_BIN=/path/to/pocketbase npx mocha -r tsx test/pocketbase.test.ts --exit --timeout 60000
 */
const BIN = process.env.POCKETBASE_BIN;
const MIGRATIONS = fileURLToPath(new URL("../pocketbase/pb_migrations", import.meta.url));
const PORT = 8097;
const URL_ = `http://127.0.0.1:${PORT}`;
const SUPERUSER = { email: "server@test.local", password: "server-pass-123" };
const PASSWORD = "secret-123";
const GAME_PORT = 2574;

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
    server = spawn(BIN, ["serve", "--http", `127.0.0.1:${PORT}`, "--dir", dir, "--migrationsDir", MIGRATIONS, "--automigrate=false"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${URL_}/api/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    admin = new PocketBase(URL_);
    admin.autoCancellation(false);
    await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    accounts.connectAccounts(URL_, SUPERUSER.email, SUPERUSER.password);
  });

  after(() => {
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  type Player = { id: string; token: string; pb: PocketBase; email: string; username: string };

  /** A new account, signed up from the app (and signed in). */
  async function signUp(fields: Record<string, unknown> = {}, email = `p${++seq}@test.local`) {
    const client = new PocketBase(URL_);
    client.autoCancellation(false);
    const { id } = await client.collection("users").create({ email, password: PASSWORD, passwordConfirm: PASSWORD, ...fields });
    const { token } = await client.collection("users").authWithPassword(email, PASSWORD);
    return { id, token, pb: client, email };
  }

  /** A player as most are: a username, a name, a free avatar (and his welcome gift already had). */
  async function player(): Promise<Player> {
    const username = `player_${++seq}`;
    const p = await signUp({ username, name: `Player_${seq}`, avatar: 103 });
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
    it("lets a player sign up with a username, a name and a free avatar, and nothing more", async () => {
      const p = await signUp({ username: "alice_1", name: "Alice", avatar: 104 });
      const me = await user(p.id);
      assert.deepStrictEqual([me.username, me.name, me.avatar, me.coins, me.xp, me.vip], ["alice_1", "Alice", 104, 0, 0, false]);
      for (const extra of [{ coins: 5 }, { xp: 1 }, { vip: true }, { avatars: [601] }, { welcomeGift: true }, { room: "R" }, { avatar: 601 }, { id: "Chosen0000000000001" }]) {
        await refused(signUp({ username: `x_${++seq}`, name: "Xavier", ...extra }));
      }
      const sneaky = await signUp({ username: `x_${++seq}`, name: "Xavier", legacyAuth: true }); // hidden: ignored
      assert.strictEqual((await user(sneaky.id)).legacyAuth, false);
      await assert.rejects(signUp({ username: "alice_1", name: "Another" }), (e: any) => e.response.data.username.code === "validation_not_unique");
      await refused(signUp({ username: "Bad Name", name: "Bad" }));
      await refused(signUp({ username: "ab", name: "Short" }));
      // Display names: 3 to 16 of [A-Za-z0-9_], any case.
      for (const name of ["Al", "x".repeat(17), "Bad Name", "Bad-Name", "Amélie", "علي"]) {
        await assert.rejects(signUp({ username: `n_${++seq}`, name }), (e: any) => !!e.response?.data?.name, name); // refused for its name
      }
      assert.strictEqual((await user((await signUp({ username: `n_${++seq}`, name: "Exactly_16_chars" })).id)).name, "Exactly_16_chars");
      assert.strictEqual((await user((await signUp({ username: `n_${++seq}`, name: "ABC" })).id)).name, "ABC");
    });

    it("lets a player change his own password and nothing else on his account", async () => {
      const p = await player();
      const other = await player();
      const { fields } = await admin.collections.getOne("users");
      const sample: Record<string, unknown> = {
        text: "renamed_1", number: 104, bool: true, json: [601], date: new Date().toISOString(), email: "new@test.local",
      };
      const allowed = ["id", "password", "tokenKey", "emailVisibility", "created", "updated"];
      const guarded = fields.filter((f) => !allowed.includes(f.name));
      assert.strictEqual(guarded.length, 19);
      for (const f of guarded) {
        assert.ok(f.type in sample, `no sample value for ${f.name} (${f.type})`);
        const change = p.pb.collection("users").update(p.id, { [f.name]: sample[f.type] });
        if (!f.hidden) {
          await assert.rejects(change, ClientResponseError, `a player changed his ${f.name}`);
          continue;
        }
        const before = (await user(p.id))[f.name]; // PocketBase ignores hidden fields from players
        await change;
        assert.strictEqual((await user(p.id))[f.name], before, `a player changed his ${f.name}`);
      }
      await refused(p.pb.collection("users").update(other.id, { emailVisibility: true }));
      await p.pb.collection("users").update(p.id, { emailVisibility: true });
      // Profiles are visible to signed-in players, not their e-mail (unless they chose to show it); not to strangers.
      const seen = await p.pb.collection("users").getOne(other.id);
      assert.strictEqual(seen.username, other.username);
      assert.ok(!seen.email);
      assert.strictEqual((await other.pb.collection("users").getOne(p.id)).email, p.email); // he chose to, above
      await refused(new PocketBase(URL_).collection("users").getOne(p.id));
      // His password (his tokens so far stop working).
      await p.pb.collection("users").update(p.id, { oldPassword: PASSWORD, password: "new-secret-1", passwordConfirm: "new-secret-1" });
      await new PocketBase(URL_).collection("users").authWithPassword(p.email, "new-secret-1");
      await refused(p.pb.collection("users").getOne(other.id));
      // He can delete his account.
      const leaving = await player();
      await leaving.pb.collection("users").delete(leaving.id);
    });

    it("checks the apps' tokens: a PocketBase one is a player; anything else (an old app's Firebase token) is refused", async () => {
      const p = await player();
      await admin.collection("users").update(p.id, { vip: true, frame: 2 });
      assert.deepStrictEqual(await accounts.accountFor(p.token), { uid: p.id, name: p.username.replace("player_", "Player_"), avatar: 103, frame: 2, vip: true });
      const firebaseLike = [{ alg: "RS256", kid: "abc" }, { iss: "https://securetoken.google.com/x", sub: p.id, user_id: p.id }]
        .map((o) => Buffer.from(JSON.stringify(o)).toString("base64url")).join(".") + ".c2lnbmF0dXJl";
      for (const bad of ["", "garbage", firebaseLike, p.token.slice(0, -2)]) {
        await assert.rejects(accounts.accountFor(bad), accounts.AuthError);
      }
      const google = await signUp({}); // signed in, no username picked yet
      await assert.rejects(accounts.accountFor(google.token), /no profile/);
      process.env.ADMIN_EMAILS = `someone@else.com, ${p.email.toUpperCase()}`;
      assert.strictEqual(await accounts.isAdmin(p.token), true);
      assert.strictEqual(await accounts.isAdmin(google.token), false);
      assert.strictEqual(await accounts.isAdmin(firebaseLike), false);
      delete process.env.ADMIN_EMAILS;
    });

    it("updates a profile: the name once a day, free or owned avatars and frames, a username only once", async () => {
      const p = await player();
      await admin.collection("users").update(p.id, { avatars: [601], frames: [3] });
      const changed = await accounts.updateProfile(p.token, { name: "  New_Name ", avatar: 601, frame: 3 });
      assert.deepStrictEqual([changed.name, changed.avatar, changed.frame], ["New_Name", 601, 3]);
      await assert.rejects(accounts.updateProfile(p.token, { name: "Again" }), /too soon/);
      await accounts.updateProfile(p.token, { name: "New_Name", avatar: 104, frame: 0 }); // same name: not a change
      await assert.rejects(accounts.updateProfile(p.token, { avatar: 602 }), /avatar/);
      await assert.rejects(accounts.updateProfile(p.token, { frame: 4 }), /frame/);
      for (const name of ["", "Al", "x".repeat(17), "Two Words", "dash-ed", "Amélie"]) {
        await assert.rejects(accounts.updateProfile(p.token, { name }), (e: any) => e instanceof accounts.ProfileError && e.status === 400, name);
      }
      await assert.rejects(accounts.updateProfile(p.token, { username: "other_name" }), /username set/);
      await admin.collection("users").update(p.id, { nameChangedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
      assert.strictEqual((await accounts.updateProfile(p.token, { name: "Third" })).name, "Third");
      // A Google player's first username and name (that name isn't a change).
      const g = await signUp({});
      await assert.rejects(accounts.updateProfile(g.token, { username: p.username }), /taken/);
      await assert.rejects(accounts.updateProfile(g.token, { username: "No Spaces" }), /username/);
      const set = await accounts.updateProfile(g.token, { username: "Gamer_1", name: "Gamer", avatar: 104 });
      assert.deepStrictEqual([set.username, set.name, set.nameChangedAt], ["gamer_1", "Gamer", ""]);
      await accounts.updateProfile(g.token, { name: "Gamer_Two" }); // his first change
      await assert.rejects(accounts.updateProfile(g.token, { name: "Gamer_Three" }), /too soon/);
      await assert.rejects(accounts.updateProfile("garbage", { name: "Nope" }), accounts.AuthError);
    });

    it("gives each new account its welcome gift once, with its date and private info", async () => {
      const p = await signUp({ username: `new_${++seq}`, name: "Newbie", avatar: 103 });
      await accounts.giveWelcomeGifts();
      await accounts.giveWelcomeGifts();
      const me = await user(p.id);
      assert.deepStrictEqual([me.coins, me.diamonds, me.welcomeGift, me.createdAt], [10_000, 1_000, true, me.created]);
      assert.deepStrictEqual(me.stats, { games: 0, wins: 0, losses: 0 });
      const info = await p.pb.collection("private_info").getOne(p.id);
      assert.deepStrictEqual([info.email, info.provider, info.createdAt], [p.email, "password", me.created]);
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
      await assert.rejects(accounts.buyAvatar(p.token, 101), /funds/);
      await admin.collection("users").update(p.id, { coins: 700, diamonds: 200 });
      // Two buys at once, money for one.
      const buys = await Promise.allSettled([accounts.buyAvatar(p.token, 101), accounts.buyAvatar(p.token, 102)]);
      assert.deepStrictEqual(buys.map((b) => b.status).sort(), ["fulfilled", "rejected"]);
      const me = await user(p.id);
      assert.strictEqual(me.coins, 200);
      assert.strictEqual(me.avatars.length, 1);
      assert.strictEqual(me.avatar, me.avatars[0]);
      await assert.rejects(accounts.buyAvatar(p.token, me.avatar), /owned/);
      await assert.rejects(accounts.buyAvatar(p.token, 103), /free/);
      await assert.rejects(accounts.buyAvatar(p.token, 9999), /unknown/);
      assert.deepStrictEqual(await accounts.buyFrame(p.token, 2), { frame: 2, diamonds: 50 });
      assert.deepStrictEqual([(await user(p.id)).frames, (await user(p.id)).frame], [[2], 2]);
      await assert.rejects(accounts.buyAvatar("garbage", 101), accounts.AuthError);
    });

    it("hands out a mission's reward once, when it's done", async () => {
      const p = await player();
      await assert.rejects(accounts.claimMission(p.token, "d_win1"), /not claimable/);
      await accounts.recordResults([result(p.id, true)]);
      assert.deepStrictEqual(await accounts.claimMission(p.token, "d_win1"), { coins: 40, xp: 20, diamonds: 0 });
      await assert.rejects(accounts.claimMission(p.token, "d_win1"), /not claimable/);
      await assert.rejects(accounts.claimMission(p.token, "nope"), /unknown/);
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
      assert.strictEqual(await accounts.setVip(p.email, true), p.username);
      assert.strictEqual((await user(p.id)).vip, true);
      await accounts.setVip(p.username.toUpperCase(), false);
      assert.strictEqual((await user(p.id)).vip, false);
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

    it("lets a signed-in player into a game as himself, and refuses a token PocketBase doesn't know with 4401", async () => {
      const p = await player();
      const room: any = await colyseus.createRoom("rummy", {});
      const client = await colyseus.connectTo(room, { idToken: p.token });
      await assert.rejects(colyseus.connectTo(room, { idToken: "an old app's Firebase token" }), /auth/);
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
      const app = await colyseus.sdk.joinOrCreate("presence", { idToken: p.token });
      await until(async () => (await state(p)) === "online");
      await app.leave();
      await until(async () => (await state(p)) === "offline");
    });

    it("answers /api/profile and /api/auth/legacy-login", async () => {
      const p = await player();
      const post = (path: string, body: unknown, token?: string) =>
        fetch(`http://127.0.0.1:${GAME_PORT}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
      const ok = await post("/api/profile", { avatar: 104 }, p.token);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await ok.json()).avatar, 104);
      assert.strictEqual((await post("/api/profile", { avatar: 601 }, p.token)).status, 409);
      assert.strictEqual((await post("/api/profile", { name: "" }, p.token)).status, 400);
      assert.strictEqual((await post("/api/profile", { avatar: 104 }, "garbage")).status, 401);
      assert.strictEqual((await post("/api/profile", { avatar: 104 })).status, 400);
      assert.strictEqual((await post("/api/avatars/buy", { id: 101 }, "garbage")).status, 401);
      assert.strictEqual((await post("/api/auth/legacy-login", {})).status, 400);
      // No FIREBASE_WEB_API_KEY here: an account still waiting for its password can't move.
      const waiting = await signUp({ username: `w_${++seq}`, name: "Waiting" });
      await admin.collection("users").update(waiting.id, { legacyAuth: true });
      delete process.env.FIREBASE_WEB_API_KEY;
      assert.strictEqual((await post("/api/auth/legacy-login", { email: waiting.email, password: "whatever" })).status, 503);
      assert.strictEqual((await post("/api/auth/legacy-login", { email: p.email, password: "whatever" })).status, 409); // has his own
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
        { uid: A, email: "Anna@Example.com", emailVerified: false, password: true, googleId: null, created: t(0) },
        { uid: G, email: "gus@example.com", emailVerified: true, password: false, googleId: "100000000000000000001", created: t(1) },
        { uid: N, email: "nora@example.com", emailVerified: false, password: true, googleId: null, created: t(2) },
      ],
      users: [
        { id: A, data: {
          username: "Anna", usernameLower: "anna", name: "Anna", avatar: 103, frame: 2, avatars: [101, 601], frames: [2],
          xp: 120, coins: 3400, diamonds: 50, rankPoints: 7, stats: { games: 9, wins: 4, losses: 5 }, room: "OLD",
          vip: true, welcomeGift: true, nameChangedAt: t(5), createdAt: t(0),
        } },
        { id: G, data: {
          username: "gus", usernameLower: "gus", name: "Gus, whose name is far too long", avatar: 104, xp: 0, coins: -5,
          diamonds: 0, rankPoints: 0, stats: { games: 0, wins: 0, losses: 0 }, createdAt: t(1),
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
        [anna.email, anna.username, anna.name, anna.avatars, anna.coins, anna.vip, anna.room, anna.welcomeGift, anna.legacyAuth, anna.verified],
        ["anna@example.com", "anna", "Anna", [101, 601], 3400, true, "", true, true, false],
      );
      assert.deepStrictEqual([anna.createdAt, anna.nameChangedAt], [t(0).toISOString().replace("T", " "), t(5).toISOString().replace("T", " ")]);
      const gus = await user(G);
      assert.deepStrictEqual([gus.name, gus.coins, gus.legacyAuth, gus.verified], ["gus", 0, false, true]); // his name didn't fit
      const nora = await user(N);
      assert.deepStrictEqual([nora.username, nora.legacyAuth, nora.welcomeGift], ["", true, true]);
      const link = await admin.collection("_externalAuths").getFirstListItem(`recordRef = "${G}"`);
      assert.deepStrictEqual([link.provider, link.providerId], ["google", "100000000000000000001"]);
      const info = await admin.collection("private_info").getOne(A);
      assert.deepStrictEqual([info.birthDate, info.provider], ["1999-05-04", "password"]);
      assert.strictEqual((await admin.collection("private_info").getOne(G)).provider, "google.com");
      assert.strictEqual((await admin.collection("missions").getOne(`${A}_d-2026-09-01`)).games, 3);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${A}_w-2026-08-31`)).xp, 300);
      assert.strictEqual((await admin.collection("leaderboard").getOne(`${G}_w-2026-08-31`)).name, "Gus, whose name ");
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
        "cut to 16 characters", "coins -5 raised to 0", "usernames/gus", 'reason "weird"',
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

    it("signs Google players in: a copied one finds his account, a new one gets a fresh one", async () => {
      // A stand-in for Google's token and userinfo endpoints (PocketBase's google provider, pointed at it).
      const people: Record<string, Record<string, unknown>> = {
        gus: { sub: "100000000000000000001", email: "gus@example.com" }, // copied from Firebase, linked
        newbie: { sub: "200000000000000000002", email: "newbie@gmail.com" },
        same: { sub: "300000000000000000003", email: "same.email@gmail.com" }, // an e-mail account's address
      };
      const google = createServer((req, res) => {
        const who = req.url === "/token" ? null : String(req.headers.authorization ?? "").replace("Bearer token-", "");
        let body = "";
        req.on("data", (c) => (body += c)).on("end", () => {
          res.setHeader("content-type", "application/json");
          if (req.url === "/token") {
            const code = new URLSearchParams(body).get("code");
            return res.end(JSON.stringify({ access_token: `token-${code}`, token_type: "Bearer", expires_in: 3600 }));
          }
          const p = people[who!];
          res.end(JSON.stringify({ ...p, id: p.sub, email_verified: true, verified_email: true, name: "Google Name That Is Far Too Long For Us", picture: "" }));
        });
      }).listen(8095);
      try {
        const users = await admin.collections.getOne("users");
        await admin.collections.update("users", { oauth2: { ...users.oauth2, enabled: true, providers: [{
          name: "google", clientId: "id", clientSecret: "secret",
          authURL: "http://127.0.0.1:8095/auth", tokenURL: "http://127.0.0.1:8095/token", userInfoURL: "http://127.0.0.1:8095/userinfo",
        }] } });
        const signIn = (code: string) => new PocketBase(URL_).collection("users").authWithOAuth2Code("google", code, "verifier-0123456789", "http://localhost/cb");
        const gus = await signIn("gus");
        assert.deepStrictEqual([gus.record.id, gus.record.username, gus.meta?.isNew], [G, "gus", false]);
        const fresh = await signIn("newbie");
        assert.deepStrictEqual([fresh.record.username, fresh.record.name, fresh.record.avatar, fresh.record.verified, fresh.meta?.isNew], ["", "", 0, true, true]);
        await assert.rejects(accounts.accountFor(fresh.token), /no profile/); // until he picks his username
        await accounts.updateProfile(fresh.token, { username: "newbie", name: "Newbie", avatar: 104 });
        assert.strictEqual((await accounts.accountFor(fresh.token)).name, "Newbie");
        assert.strictEqual((await signIn("newbie")).record.id, fresh.record.id);
        // An e-mail account, then Google with the same address: PocketBase links them.
        const mail = await signUp({ username: `same_${++seq}`, name: "Same" }, "same.email@gmail.com");
        assert.strictEqual((await signIn("same")).record.id, mail.id);
      } finally {
        google.close();
      }
    });

    it("moves an e-mail player's password from Firebase at his first login, once", async () => {
      let asked = 0;
      const firebase = async (email: string, password: string) => {
        asked++;
        const known: Record<string, [string, string]> = {
          "anna@example.com": [A, "hunter2"], // 7 characters: Firebase allowed 6
          "late@example.com": ["LateFirebaseUid0000000000005", "late-pass"],
          "nora@example.com": ["SomeoneElseUid00000000000006", "nora-pass"],
        };
        return known[email]?.[1] === password ? known[email][0] : null;
      };
      const login = (email: string, password: string) => new PocketBase(URL_).collection("users").authWithPassword(email, password);
      await assert.rejects(login("anna@example.com", "hunter2"), (e: any) => e.status === 400); // the app's cue to try the legacy login
      await assert.rejects(legacyLogin("anna@example.com", "wrong", firebase), (e: any) => e instanceof LegacyLoginError && e.status === 401);
      await legacyLogin(" Anna@Example.com ", "hunter2", firebase);
      const { record, token } = await login("anna@example.com", "hunter2");
      assert.strictEqual(record.id, A);
      assert.strictEqual((await accounts.accountFor(token)).name, "Anna");
      assert.strictEqual((await user(A)).legacyAuth, false);
      // Moved: never again, and Firebase isn't even asked.
      asked = 0;
      await assert.rejects(legacyLogin("anna@example.com", "hunter2", firebase), (e: any) => e.status === 409);
      assert.strictEqual(asked, 0);
      // A Google player has nothing to move.
      await assert.rejects(legacyLogin("gus@example.com", "x", firebase), (e: any) => e.status === 409);
      // Firebase's uid for this e-mail isn't the account's: refused.
      await assert.rejects(legacyLogin("nora@example.com", "nora-pass", firebase), (e: any) => e.status === 409);
      // Signed up on Firebase after the copy: an empty account under his uid, for him to set up.
      await legacyLogin("late@example.com", "late-pass", firebase);
      const late = await login("late@example.com", "late-pass");
      assert.deepStrictEqual([late.record.id, late.record.username, late.record.welcomeGift], ["LateFirebaseUid0000000000005", "", true]);
      assert.strictEqual((await admin.collection("private_info").getOne("LateFirebaseUid0000000000005")).provider, "password");
      // Five wrong tries, then it waits.
      for (let i = 0; i < 4; i++) await assert.rejects(legacyLogin("nora@example.com", "bad", firebase), (e: any) => e.status === 401);
      await assert.rejects(legacyLogin("nora@example.com", "bad", firebase), (e: any) => e.status === 429);
    });
  });
});
