import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WerewolfState } from "../src/rooms/schema/WerewolfState.js";

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// One of each role with 5 players; the day debate is as short as allowed.
const ONE_OF_EACH = { wolves: 1, villagers: 1, seer: true, witch: true, protector: true, roundSeconds: 10 };
const STEP = 15_000; // a night step lasts 10s (night 1's first one 13.5s: it covers the card deal)

describe("WerewolfRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startGame(options: object = ONE_OF_EACH, players = 5) {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", options);
    const clients: any[] = [];
    for (let i = 0; i < players; i++) clients.push(await colyseus.connectTo(room)); // join order: clients[0] is host
    const rolesPromise = Promise.all(clients.map((c) => c.waitForMessage("role_assigned", STEP)));
    clients[0].send("start_game"); // roles are dealt after the 10s countdown
    const roles = (await rolesPromise).map((m: any) => m.role as string);
    const byRole = (role: string) => clients[roles.indexOf(role)];
    return { room, clients, roles, byRole };
  }

  it("deals the host's role mix and starts the night with the protector", async () => {
    const { room, roles } = await startGame();
    assert.deepStrictEqual([...roles].sort(), ["protector", "seer", "villager", "werewolf", "witch"]);
    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(room.state.nightStep, "protector");
    assert.strictEqual(room.state.nightRoles, "protector");
  });

  it("drops villagers first when fewer players join than the mix plans", async () => {
    const { room, roles } = await startGame({ maxPlayers: 8, wolves: 2, villagers: 3 });
    assert.strictEqual(room.state.maxPlayers, 8);
    assert.deepStrictEqual([...roles].sort(), ["protector", "seer", "werewolf", "werewolf", "witch"]);
  });

  it("only lets the host change settings, and validates them", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room);
    const guest = await colyseus.connectTo(room);
    guest.send("settings", { maxPlayers: 12 });
    host.send("settings", { roundSeconds: 90, maxPlayers: 99, roomType: "friends", witch: false });
    await waitFor(() => room.state.roundSeconds === 90);
    assert.notStrictEqual(room.state.maxPlayers, 12); // the guest's change was ignored
    assert.strictEqual(room.state.maxPlayers, 16); // clamped
    assert.strictEqual(room.state.roomType, "friends");
    assert.strictEqual(room.state.witch, false);
    host.send("settings", { roundSeconds: 45 }); // not a 10s/30s-step value
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(room.state.roundSeconds, 90);
  });

  it("counts down 10s before starting; the host can cancel; joining is closed meanwhile", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", ONE_OF_EACH);
    const clients: any[] = [];
    for (let i = 0; i < 4; i++) clients.push(await colyseus.connectTo(room));

    clients[0].send("start_game");
    await waitFor(() => room.state.phase === "starting");
    assert.ok(room.state.phaseEndsAt > Date.now() + 8_000);
    await assert.rejects(colyseus.connectTo(room), /started/);

    const cancelled = clients[1].waitForMessage("event");
    clients[0].send("cancel_start");
    await waitFor(() => room.state.phase === "lobby");
    assert.strictEqual(((await cancelled) as any).type, "start_cancelled");
  });

  it("keeps the event log on the server: waiting-room lines, host change, and a full log for newcomers", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room, { name: "Aya" });
    const other = await colyseus.connectTo(room, { name: "Bilal" });
    await host.leave();
    await waitFor(() => room.state.hostId === other.sessionId);

    // (Newcomers get this list in their join handshake — before a test could listen, so read it from the room.)
    const log: any[] = (room as any).publicLog;
    assert.deepStrictEqual(
      log.map((e) => [e.type, e.name]),
      [["created", "Aya"], ["joined", "Bilal"], ["left", "Aya"], ["new_host", "Bilal"]],
    );
  });

  it("kicks and bans a player until the host changes", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room, { playerId: "host-device" });
    const other = await colyseus.connectTo(room, { playerId: "other-device" });
    const guest = await colyseus.connectTo(room, { playerId: "guest-device" });

    const kicked = guest.waitForMessage("kicked");
    host.send("kick", { targetId: guest.sessionId });
    await kicked;
    await waitFor(() => !room.state.players.has(guest.sessionId));
    await assert.rejects(colyseus.connectTo(room, { playerId: "guest-device" }), /banned/);

    await host.leave(); // "other" becomes host → bans are lifted
    await waitFor(() => room.state.hostId === other.sessionId);
    const back = await colyseus.connectTo(room, { playerId: "guest-device" });
    assert.ok(room.state.players.has(back.sessionId));
  });

  it("lets spectators watch a running game without taking a seat", async () => {
    const { room } = await startGame();
    await assert.rejects(colyseus.connectTo(room, { playerId: "late" }), /started/);
    const watcher = await colyseus.connectTo(room, { spectator: true, playerId: "watcher" });
    await waitFor(() => room.state.spectators === 1);
    assert.strictEqual(room.state.players.size, 5);
    assert.ok(!room.state.players.has(watcher.sessionId));
  });

  it("kills a player who quits mid-game, but holds a dropped player's seat", async () => {
    const { room, clients } = await startGame();
    const [quitter, dropper] = [clients[1], clients[2]];

    const gone = clients[0].waitForMessage("player_gone");
    const reveal = clients[0].waitForMessage("death_reveal");
    await quitter.leave(true); // on purpose
    assert.strictEqual((await reveal).cause, "quit");
    const g: any = await gone;
    assert.strictEqual(g.id, quitter.sessionId);
    assert.strictEqual(g.reason, "quit");
    assert.strictEqual(room.state.players.get(quitter.sessionId)?.alive, false);

    dropper.reconnection.enabled = false; // like a killed app: the JS SDK would otherwise reconnect by itself
    await dropper.leave(false); // network drop / app killed
    await waitFor(() => room.state.players.get(dropper.sessionId)?.connected === false);
    assert.strictEqual(room.state.players.get(dropper.sessionId)?.alive, true); // seat held for 10 minutes
  });

  it("gives the host their test role", async () => {
    const { roles } = await startGame({ ...ONE_OF_EACH, testRole: "witch" });
    assert.strictEqual(roles[0], "witch");
  });

  it("plays a night: protector → wolves → witch sees the victim and revives it", async function () {
    this.timeout(30_000);
    const { room, byRole } = await startGame();
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const villager = byRole("villager"), protector = byRole("protector");

    protector.send("protect", { targetId: protector.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");

    const witchTurn = witch.waitForMessage("witch_turn", STEP);
    wolf.send("wolf_target", { targetId: villager.sessionId });
    assert.deepStrictEqual(await witchTurn, { victim: villager.sessionId, canPoison: true });
    assert.strictEqual(room.state.nightStep, "witch_seer");
    assert.strictEqual(room.state.nightRoles, "witch,seer");

    const peek = seer.waitForMessage("seer_result");
    seer.send("seer_peek", { targetId: wolf.sessionId });
    assert.strictEqual((await peek).role, "werewolf");

    const night = villager.waitForMessage("night_result");
    witch.send("witch_revive");
    witch.send("witch_pass");
    assert.deepStrictEqual(await night, { deaths: [], saved: true });
    assert.strictEqual(room.state.phase, "mayor"); // first night over → the village elects a mayor
  });

  it("reveals each night death with its cause: the wolves' victim first, then the witch's poison", async function () {
    this.timeout(30_000);
    const { room, byRole } = await startGame();
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const villager = byRole("villager"), protector = byRole("protector");

    protector.send("protect", { targetId: protector.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    const witchTurn = witch.waitForMessage("witch_turn", STEP);
    wolf.send("wolf_target", { targetId: villager.sessionId });
    await witchTurn;

    const reveals: any[] = [];
    seer.onMessage("death_reveal", (d) => reveals.push(d));
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_poison", { targetId: seer.sessionId });
    witch.send("witch_pass");
    await waitFor(() => reveals.length === 2);
    const nameOf = (c: typeof seer) => room.state.players.get(c.sessionId)!.name;
    assert.deepStrictEqual(reveals, [
      { id: villager.sessionId, name: nameOf(villager), role: "villager", cause: "wolves", shooter: false },
      { id: seer.sessionId, name: nameOf(seer), role: "seer", cause: "witch", shooter: false },
    ]);
  });

  it("hides the revive when the wolves attack the protected player", async function () {
    this.timeout(30_000);
    const { byRole } = await startGame();
    const wolf = byRole("werewolf"), witch = byRole("witch"), villager = byRole("villager");

    byRole("protector").send("protect", { targetId: villager.sessionId });
    const witchTurn = witch.waitForMessage("witch_turn", STEP);
    await new Promise((r) => setTimeout(r, 50));
    wolf.send("wolf_target", { targetId: villager.sessionId });
    assert.deepStrictEqual(await witchTurn, { victim: null, canPoison: true });
  });

  it("lets wolves vote each other: the most-voted dies even if he's a wolf", async function () {
    this.timeout(30_000);
    const { room, clients, roles } = await startGame({ ...ONE_OF_EACH, wolves: 2, villagers: 0, protector: false });
    const [wolfA, wolfB] = clients.filter((_, i) => roles[i] === "werewolf");

    await waitFor(() => room.state.nightStep === "wolves");
    const seen = wolfB.waitForMessage("wolf_votes");
    wolfA.send("wolf_target", { targetId: wolfA.sessionId });
    assert.deepStrictEqual(await seen, { [wolfA.sessionId]: wolfA.sessionId }); // packmates see each vote
    wolfB.send("wolf_target", { targetId: wolfA.sessionId });

    const night = wolfB.waitForMessage("night_result", STEP + 12_000);
    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    for (const c of clients) {
      if (roles[clients.indexOf(c)] === "seer") c.send("seer_peek", { targetId: wolfB.sessionId });
      if (roles[clients.indexOf(c)] === "witch") c.send("witch_pass");
    }
    assert.deepStrictEqual((await night).deaths, [wolfA.sessionId]);
  });

  it("elects a mayor whose exclusion vote counts twice", async function () {
    this.timeout(45_000);
    const { room, byRole } = await startGame();
    const [wolf, witch, seer] = [byRole("werewolf"), byRole("witch"), byRole("seer")];
    const [villager, protector] = [byRole("villager"), byRole("protector")];

    // A quick night where nobody dies.
    protector.send("protect", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_pass");
    await waitFor(() => room.state.phase === "mayor");

    const elected = villager.waitForMessage("mayor_result");
    for (const c of [wolf, witch, seer, villager, protector]) c.send("day_vote", { targetId: villager.sessionId });
    assert.deepStrictEqual(await elected, { mayorId: villager.sessionId });
    assert.strictEqual(room.state.mayorId, villager.sessionId);

    await waitFor(() => room.state.phase === "vote", STEP);
    const result = villager.waitForMessage("vote_result");
    villager.send("day_vote", { targetId: wolf.sessionId }); // mayor: 2 votes
    seer.send("day_vote", { targetId: witch.sessionId });
    witch.send("day_vote", { targetId: protector.sessionId });
    protector.send("day_vote", { targetId: seer.sessionId });
    wolf.send("day_vote", { targetId: wolf.sessionId }); // voting for yourself is allowed
    const r: any = await result;
    assert.strictEqual(r.excluded, wolf.sessionId);
    assert.strictEqual(r.votes, 3); // mayor ×2 + the wolf himself
    assert.strictEqual(r.day, 1);
    assert.strictEqual(r.mayorId, villager.sessionId);
    assert.strictEqual(r.ballots[seer.sessionId], witch.sessionId); // every ballot is kept for the history
    assert.strictEqual(room.state.winner, "villagers");
    assert.ok(room.state.phaseEndsAt > Date.now() + 50_000); // the room closes a minute after the game

    // What someone arriving now gets: the whole game's log, lobby lines excluded.
    const types = ((room as any).publicLog as any[]).map((e) => e.type);
    assert.strictEqual(types[0], "night");
    assert.ok(types.includes("mayor") && types.includes("vote_result"));
    assert.strictEqual(types.at(-1), "game_over");
    assert.ok(!types.includes("your_role")); // private lines stay private
  });

  it("never lets the protector protect the same player two nights in a row", async function () {
    this.timeout(180_000);
    const { room, clients, roles, byRole } = await startGame({ ...ONE_OF_EACH, witch: false, villagers: 2 });
    const [protector, seer, wolf] = [byRole("protector"), byRole("seer"), byRole("werewolf")];
    const [villagerA, villagerB] = clients.filter((_, i) => roles[i] === "villager");

    // A night where the wolf attacks exactly the protected player: nobody dies.
    const quietNight = async (target: any) => {
      await waitFor(() => room.state.nightStep === "protector", 60_000);
      protector.send("protect", { targetId: target.sessionId });
      await waitFor(() => room.state.nightStep === "wolves");
      wolf.send("wolf_target", { targetId: target.sessionId });
      await waitFor(() => room.state.nightStep === "witch_seer", STEP);
      seer.send("seer_peek", { targetId: wolf.sessionId });
    };
    // A day whose vote is a 2–2 tie (nobody votes in the mayor election, so there's no mayor): nobody goes out.
    const quietDay = async () => {
      await waitFor(() => room.state.phase === "vote", 60_000);
      protector.send("day_vote", { targetId: villagerA.sessionId });
      seer.send("day_vote", { targetId: villagerA.sessionId });
      villagerA.send("day_vote", { targetId: villagerB.sessionId });
      villagerB.send("day_vote", { targetId: villagerB.sessionId });
      await waitFor(() => room.state.phase === "night", STEP);
    };

    await quietNight(protector); // night 1: himself
    await quietDay();
    await quietNight(villagerA); // night 2: someone else
    await quietDay();

    await waitFor(() => room.state.nightStep === "protector", 60_000); // night 3: villager A again → refused
    const refused = protector.waitForMessage("error");
    protector.send("protect", { targetId: villagerA.sessionId });
    assert.deepStrictEqual(await refused, { code: "same_protect" });
    assert.strictEqual(room.state.nightStep, "protector");
  });

  it("lets a dead mayor name his successor", async function () {
    this.timeout(45_000);
    const { room, clients, roles, byRole } = await startGame({ ...ONE_OF_EACH, villagers: 2, protector: false });
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const [mayor, heir] = clients.filter((_, i) => roles[i] === "villager");

    // Quiet night (no protector in this mix): the witch revives the wolves' victim.
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: mayor.sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_revive");
    witch.send("witch_pass");
    await waitFor(() => room.state.phase === "mayor");

    for (const c of clients) c.send("day_vote", { targetId: mayor.sessionId });
    await waitFor(() => room.state.mayorId === mayor.sessionId);

    await waitFor(() => room.state.phase === "vote", STEP);
    for (const c of clients) c.send("day_vote", { targetId: mayor.sessionId }); // the village votes its mayor out
    await waitFor(() => room.state.phase === "reveal"); // his card reveal plays first…
    await waitFor(() => room.state.phase === "succession", 6_000); // …then his 10s to name a successor
    assert.strictEqual(room.state.successionFrom, mayor.sessionId);

    const handover = heir.waitForMessage("mayor_result");
    mayor.send("mayor_successor", { targetId: heir.sessionId });
    assert.deepStrictEqual(await handover, { mayorId: heir.sessionId, successor: true });
    assert.strictEqual(room.state.mayorId, heir.sessionId);
    assert.strictEqual(room.state.phase, "night");
  });

  const NO_SPECIALS = { seer: false, witch: false, protector: false, roundSeconds: 10 };

  it("springs the wild hunter's trap on the wolf who attacks the trapped player; the detective compares teams", async function () {
    this.timeout(45_000);
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 1, wildhunter: true, hunter: true, detective: true };
    const { room, byRole } = await startGame(mix);
    const [wolf, villager, detective] = [byRole("werewolf"), byRole("villager"), byRole("detective")];

    assert.strictEqual(room.state.nightStep, "wild_hunter"); // night 1: he wakes first
    byRole("wildhunter").send("trap", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: villager.sessionId });

    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    const checked = detective.waitForMessage("detective_result");
    detective.send("detective_check", { a: villager.sessionId, b: wolf.sessionId });
    assert.deepStrictEqual(await checked, { a: villager.sessionId, b: wolf.sessionId, same: false });
    // Checked players are never checked again; he only wakes while two unchecked players (not him) live.
    const r = room as any;
    assert.ok(r.detectiveChecked.has(villager.sessionId) && r.detectiveChecked.has(wolf.sessionId));
    assert.strictEqual(r.canInvestigate(detective.sessionId), detective.sessionId); // wild hunter + hunter left
    r.detectiveChecked.add(byRole("hunter").sessionId);
    assert.strictEqual(r.canInvestigate(detective.sessionId), undefined);

    await waitFor(() => room.state.phase === "gameover"); // the only wolf is dead
    assert.strictEqual(room.state.players.get(wolf.sessionId)!.alive, false);
    assert.strictEqual(room.state.players.get(villager.sessionId)!.alive, true);
    assert.strictEqual(room.state.winner, "villagers");
  });

  it("lets a dead hunter take someone with him once the reveals are over", async function () {
    this.timeout(45_000);
    const { room, byRole } = await startGame({ ...NO_SPECIALS, wolves: 1, villagers: 2, hunter: true, bear: true });
    const [wolf, hunter] = [byRole("werewolf"), byRole("hunter")];

    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: hunter.sessionId });
    await waitFor(() => room.state.phase === "reveal", STEP);
    assert.ok(room.state.phaseEndsAt - Date.now() > 3_000); // time for his card reveal
    await waitFor(() => room.state.phase === "hunter", 6_000);
    assert.strictEqual(room.state.shooterId, hunter.sessionId);
    assert.ok(room.state.players.get(room.state.shooterAim)?.alive); // already aimed at someone alive, for all to see
    hunter.send("hunter_aim", { targetId: wolf.sessionId });
    await waitFor(() => room.state.shooterAim === wolf.sessionId);

    const shot = wolf.waitForMessage("death_reveal");
    hunter.send("hunter_shoot", { targetId: wolf.sessionId });
    assert.strictEqual((await shot).cause, "hunter");
    assert.strictEqual(room.state.winner, "villagers");
  });

  it("spares Red Hood from the wolves while the hunter lives; the triple face peeks on night 1; the bear sniffs", async function () {
    this.timeout(60_000);
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 1, hunter: true, redhood: true, bear: true, tripleface: true };
    const { room, clients, roles, byRole } = await startGame(mix, 6);
    const [wolf, tripleFace] = [byRole("werewolf"), byRole("tripleface")];

    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: byRole("redhood").sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    assert.strictEqual(room.state.nightRoles, "tripleface"); // a second seer tonight
    const peek = tripleFace.waitForMessage("seer_result");
    tripleFace.send("seer_peek", { targetId: wolf.sessionId });
    assert.strictEqual((await peek).role, "werewolf");

    await waitFor(() => room.state.phase === "mayor");
    assert.ok([...room.state.players.values()].every((p) => p.alive)); // Red Hood survived
    for (const c of clients) c.send("day_vote", { targetId: wolf.sessionId });
    await waitFor(() => room.state.phase === "day");

    const bear = roles.indexOf("bear");
    const n = roles.length;
    const wolfNextToBear = [roles[(bear + 1) % n], roles[(bear - 1 + n) % n]].includes("werewolf");
    const types = ((room as any).publicLog as any[]).map((e) => e.type);
    assert.strictEqual(types.includes("bear_roar"), wolfNextToBear);
  });

  it("rewards signed-in players by whole minutes played; leaving alive is a loss; an expired room counts for nobody", async () => {
    const { room, clients, roles } = await startGame();
    const r = room as any;
    const ids: string[] = clients.map((c: any) => c.sessionId);
    ids.forEach((id, i) => r.accounts.set(id, `uid${i}`));
    r.gameStartedAt = Date.now() - 7.7 * 60_000; // a 7m42s game → 7 minutes
    const wolf = roles.indexOf("werewolf");
    const quitter = roles.indexOf("seer");
    r.quitAlive.set(ids[quitter], Date.now() - 2.5 * 60_000); // left alive after ~5 minutes

    const told = clients[0].waitForMessage("event");
    r.endGame("villagers");
    const byUid = Object.fromEntries(r.lastResults.map((x: any) => [x.uid, x]));
    assert.deepStrictEqual(byUid[`uid${wolf}`], { uid: `uid${wolf}`, role: "werewolf", won: false, minutes: 7 });
    assert.deepStrictEqual(byUid[`uid${quitter}`], { uid: `uid${quitter}`, role: "seer", won: false, minutes: 5 });
    const winner = roles.indexOf("villager");
    assert.deepStrictEqual(byUid[`uid${winner}`], { uid: `uid${winner}`, role: "villager", won: true, minutes: 7 });

    const events = [await told, ...r.privateLogs.get(ids[0])].filter((e: any) => e.type === "reward");
    const expected = roles[0] === "werewolf" || ids[0] === ids[quitter]
      ? { xp: roles[0] === "werewolf" ? 7 : 5, coins: 0 }
      : { xp: 21, coins: 21 }; // winners: 3 XP + 3 coins a minute; losers: 1 XP
    assert.strictEqual(events[0].xp, expected.xp);
    assert.strictEqual(events[0].coins, expected.coins);

    r.lastResults = [];
    r.endGame(null); // the room expired
    assert.deepStrictEqual(r.lastResults, []);
  });

  it("gives voice rights by phase: night is wolves only, the dead and spectators never talk", async function () {
    this.timeout(30_000);
    const { room, byRole } = await startGame();
    const r = room as any;
    const rights = (c: any) => r.voiceRightsOf(c.sessionId);
    const [wolf, seer] = [byRole("werewolf"), byRole("seer")];
    assert.strictEqual(room.state.phase, "night");
    assert.deepStrictEqual(rights(wolf), { talk: true, hear: true });
    assert.deepStrictEqual(rights(seer), { talk: false, hear: false }); // villagers sleep: they hear nothing

    room.state.phase = "day";
    assert.deepStrictEqual(rights(seer), { talk: true, hear: true });
    room.state.phase = "vote";
    assert.deepStrictEqual(rights(seer), { talk: false, hear: true }); // votes: mics off
    room.state.phase = "day";
    room.state.players.get(seer.sessionId)!.alive = false;
    assert.deepStrictEqual(rights(seer), { talk: false, hear: true }); // the dead listen
    assert.ok(r.inGraveyard(seer.sessionId) && !r.inGraveyard(wolf.sessionId)); // the dead talk in the graveyard
    r.spectators.add("watcher");
    assert.deepStrictEqual(r.voiceRightsOf("watcher"), { talk: false, hear: true });
    room.state.phase = "night";
    assert.deepStrictEqual(r.voiceRightsOf("watcher"), { talk: false, hear: false });
  });

  it("keeps one seat per player: joining again replaces the old seat (and keeps host)", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const first = await colyseus.connectTo(room, { playerId: "phone-1", name: "Pablo" });
    await colyseus.connectTo(room, { playerId: "phone-2", name: "Ferhat" });
    assert.strictEqual(room.state.hostId, first.sessionId);
    const again = await colyseus.connectTo(room, { playerId: "phone-1", name: "Pablo" }); // his app gave up and retried
    await waitFor(() => room.state.players.size === 2);
    assert.ok(!room.state.players.has(first.sessionId));
    assert.strictEqual(room.state.hostId, again.sessionId);
  });

  it("lets only invited players into a private room, and never spectates a lobby", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room, { name: "Host" });
    host.send("settings", { roomType: "private" });
    await waitFor(() => room.state.roomType === "private");


    const r = room as any;
    await assert.rejects(r.checkRoomType(null), /private/); // a guest, not invited
    r.members.set(host.sessionId, "hostUid");
    await assert.rejects(r.checkRoomType({ uid: "friendUid", name: "F", avatar: 1 }), /private/);
    r.invited.add("friendUid");
    await r.checkRoomType({ uid: "friendUid", name: "F", avatar: 1 }); // invited: welcome
    await assert.rejects(colyseus.connectTo(room, { spectator: true }), /lobby/); // lobbies are joined, not watched
  });
});
