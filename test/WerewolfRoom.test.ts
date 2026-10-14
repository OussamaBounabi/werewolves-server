import assert from "assert";
import { ColyseusTestServer } from "@colyseus/testing";

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

  before(async () => {
    // As boot() does, but not on its 2568: a playground tunnel there would take these connections.
    await appConfig.listen(2571);
    colyseus = new ColyseusTestServer(appConfig);
  });
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  /**
   * A game started, up to night 1. A room that plays with a mayor opens on his election (a whole day): [mayor]
   * names who everyone votes for, by the roles dealt; without it nobody votes, so the village has no mayor.
   * [opened]: the phase the game opened on.
   */
  async function startGame(options: object = ONE_OF_EACH, players = 5, mayor?: (roles: string[]) => number) {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", options);
    const clients: any[] = [];
    for (let i = 0; i < players; i++) clients.push(await colyseus.connectTo(room)); // join order: clients[0] is host
    const rolesPromise = Promise.all(clients.map((c) => c.waitForMessage("role_assigned", STEP)));
    clients[0].send("start_game"); // roles are dealt after the 10s countdown
    const roles = (await rolesPromise).map((m: any) => m.role as string);
    const byRole = (role: string) => clients[roles.indexOf(role)];
    const opened = room.state.phase;
    if (opened === "mayor") {
      if (mayor) {
        const pick = clients[mayor(roles)].sessionId;
        for (const c of clients) c.send("day_vote", { targetId: pick });
        await waitFor(() => [...room.state.players.values()].every((p) => p.votedFor === pick));
      }
      // The election day's end, without waiting for it — and until everyone has heard the night fall: a test
      // that listens for the next event must not get the election's.
      const nightHeard = Promise.all(clients.map((c) => new Promise<void>((heard) => {
        c.onMessage("event", (e: any) => e.type === "night" && heard());
      })));
      (room as any).resolveMayor();
      await nightHeard;
    }
    return { room, clients, roles, byRole, opened };
  }

  it("deals the host's role mix, elects the mayor, then starts the night with the protector", async () => {
    const { room, roles, opened } = await startGame();
    assert.deepStrictEqual([...roles].sort(), ["protector", "seer", "villager", "werewolf", "witch"]);
    assert.strictEqual(opened, "mayor"); // the roles dealt, the election comes first
    assert.strictEqual(room.state.dayNumber, 1);
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
    host.send("settings", { roundSeconds: 45, stepSeconds: 30 }); // 45: not a 10s/30s-step value
    await waitFor(() => room.state.stepSeconds === 30);
    assert.strictEqual(room.state.roundSeconds, 90);
    host.send("settings", { stepSeconds: 70 }); // over a minute
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(room.state.stepSeconds, 30);

    // The narrator is off unless the host turns him on. Picking his own role is a VIP host's.
    const r = room as any;
    assert.strictEqual(room.state.narrator, false);
    host.send("settings", { narrator: true, testRole: "seer" });
    await waitFor(() => room.state.narrator === true);
    assert.strictEqual(r.testHostRole, null);
    r.vips.add(host.sessionId);
    host.send("settings", { testRole: "seer" });
    await waitFor(() => r.testHostRole === "seer");
    host.send("transfer_host", { targetId: guest.sessionId }); // the role he picked doesn't pass to the next host
    await waitFor(() => room.state.hostId === guest.sessionId);
    assert.strictEqual(r.testHostRole, null);
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

  it("closes by itself a minute after every player's app is gone, with no winner; not while one is still here", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const clients: any[] = [];
    for (let i = 0; i < 2; i++) clients.push(await colyseus.connectTo(room));
    const r = room as any;
    const drop = async (c: any) => {
      c.reconnection.enabled = false; // like a killed app
      await c.leave(false);
      await waitFor(() => room.state.players.get(c.sessionId)?.connected === false);
    };
    await drop(clients[0]);
    assert.strictEqual(r.abandon.timer, null); // one player is still here
    await drop(clients[1]);
    assert.notStrictEqual(r.abandon.timer, null); // nobody: the minute starts
    r.abandon.end(); // …and it's up
    assert.strictEqual(room.state.phase, "gameover");
    assert.strictEqual(room.state.winner, "none");
  });

  it("gives a VIP host the role he picked", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", ONE_OF_EACH);
    const clients: any[] = [];
    for (let i = 0; i < 5; i++) clients.push(await colyseus.connectTo(room));
    const r = room as any;
    r.vips.add(clients[0].sessionId); // (his account's flag, read when he joins)
    clients[0].send("settings", { testRole: "witch" });
    await waitFor(() => r.testHostRole === "witch");
    const dealt = clients[0].waitForMessage("role_assigned", STEP);
    clients[0].send("start_game");
    assert.strictEqual((await dealt).role, "witch");
  });

  it("plays a night: protector → wolves → witch sees the victim and revives it", async function () {
    this.timeout(30_000);
    const { room, byRole } = await startGame({ ...ONE_OF_EACH, narrator: true });
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const villager = byRole("villager"), protector = byRole("protector");

    protector.send("protect", { targetId: protector.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");

    const witchTurn = witch.waitForMessage("witch_turn", STEP);
    wolf.send("wolf_target", { targetId: villager.sessionId });
    // Every wolf has voted: the pack's time drops to 5 seconds.
    await waitFor(() => room.state.phaseEndsAt - Date.now() <= 5_000);
    assert.strictEqual(room.state.nightStep, "wolves");
    // Nobody kills on the first night: she can only revive.
    assert.deepStrictEqual(await witchTurn, { victim: villager.sessionId, canPoison: false });
    witch.send("witch_poison", { targetId: seer.sessionId });
    assert.strictEqual(room.state.nightStep, "witch_seer");
    assert.strictEqual(room.state.nightRoles, "witch,seer");

    const peek = seer.waitForMessage("seer_result");
    seer.send("seer_peek", { targetId: wolf.sessionId });
    assert.strictEqual((await peek).role, "werewolf");

    const night = villager.waitForMessage("night_result");
    witch.send("witch_revive");
    witch.send("witch_pass");
    assert.deepStrictEqual(await night, { deaths: [], saved: true });
    assert.strictEqual(room.state.phase, "day"); // first night over: the mayor was elected before it
    assert.ok([...room.state.players.values()].every((p) => p.alive)); // her poison stayed in its vial
    assert.strictEqual((room as any).potions.get(witch.sessionId).poison, true);
    // The narrator told of the save, under the day's title.
    const types = ((room as any).publicLog as any[]).map((e) => e.type);
    const dawn = types.indexOf("day");
    assert.deepStrictEqual(types.slice(dawn, dawn + 3), ["day", "village_wakes", "witch_saved"]);
  });

  it("reveals each night death with its cause: the wolves' victim first, then the witch's poison", async function () {
    this.timeout(30_000);
    const { room, byRole } = await startGame();
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const villager = byRole("villager"), protector = byRole("protector");
    room.state.dayNumber = 2; // (not the first night: nobody kills on that one)

    protector.send("protect", { targetId: protector.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    const witchTurn = witch.waitForMessage("witch_turn", STEP);
    wolf.send("wolf_target", { targetId: villager.sessionId });
    assert.strictEqual((await witchTurn).canPoison, true);

    const reveals: any[] = [];
    seer.onMessage("death_reveal", (d: any) => reveals.push(d));
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_poison", { targetId: seer.sessionId });
    witch.send("witch_pass");
    await waitFor(() => reveals.length === 2);
    const nameOf = (c: typeof seer) => room.state.players.get(c.sessionId)!.name;
    assert.deepStrictEqual(reveals, [
      { id: villager.sessionId, name: nameOf(villager), role: "villager", cause: "wolves", shooter: false, infected: false },
      { id: seer.sessionId, name: nameOf(seer), role: "seer", cause: "witch", shooter: false, infected: false },
    ]);
  });

  for (const narrator of [false, true]) {
    it(`hides the revive when the wolves attack the protected player; the narrator ${narrator ? "tells" : "is off: a secret"}`, async function () {
      this.timeout(30_000);
      const { room, byRole } = await startGame({ ...ONE_OF_EACH, narrator });
      const wolf = byRole("werewolf"), witch = byRole("witch"), villager = byRole("villager");

      byRole("protector").send("protect", { targetId: villager.sessionId });
      const witchTurn = witch.waitForMessage("witch_turn", STEP);
      await new Promise((r) => setTimeout(r, 50));
      wolf.send("wolf_target", { targetId: villager.sessionId });
      assert.deepStrictEqual(await witchTurn, { victim: null, canPoison: false });

      byRole("seer").send("seer_peek", { targetId: wolf.sessionId });
      witch.send("witch_pass");
      await waitFor(() => room.state.phase === "day", STEP);
      const told = ((room as any).publicLog as any[]).filter((e) => e.type === "narrator").map((e) => e.what);
      assert.deepStrictEqual(told, narrator ? ["protected"] : []); // which kind of attack failed, never on whom
    });
  }

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
    const { room, byRole } = await startGame(ONE_OF_EACH, 5, (roles) => roles.indexOf("villager"));
    const [wolf, witch, seer] = [byRole("werewolf"), byRole("witch"), byRole("seer")];
    const [villager, protector] = [byRole("villager"), byRole("protector")];
    assert.strictEqual(room.state.mayorId, villager.sessionId); // elected before the first night

    // A quick night where nobody dies.
    protector.send("protect", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_pass");

    await waitFor(() => room.state.phase === "day", STEP);
    const result = villager.waitForMessage("vote_result", STEP); // counted when the day ends
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
    assert.strictEqual(r.ballots[seer.sessionId], witch.sessionId); // every ballot is kept for the history…
    assert.strictEqual(r.ballots[villager.sessionId], wolf.sessionId); // …those against whoever went out too
    assert.strictEqual(r.ballots[wolf.sessionId], wolf.sessionId);
    assert.deepStrictEqual((room as any).voteHistory.at(-1).ballots, r.ballots);
    assert.strictEqual(room.state.winner, "villagers");
    assert.ok(room.state.phaseEndsAt > Date.now() + 50_000); // the room closes a minute after the game

    // What someone arriving now gets: the whole game's log, lobby lines excluded.
    const types = ((room as any).publicLog as any[]).map((e) => e.type);
    assert.deepStrictEqual(types.slice(0, 3), ["mayor_election", "mayor", "night"]);
    assert.ok(types.includes("vote_result"));
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
    // A day where nobody votes (a tie would add 30 seconds to break it): nobody goes out.
    const quietDay = async () => {
      await waitFor(() => room.state.phase === "day", 60_000);
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
    this.timeout(90_000);
    const mix = { ...ONE_OF_EACH, villagers: 2, protector: false };
    const { room, clients, roles, byRole } = await startGame(mix, 5, (roles) => roles.indexOf("villager"));
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const [mayor, heir] = clients.filter((_, i) => roles[i] === "villager");
    assert.strictEqual(room.state.mayorId, mayor.sessionId);

    // Quiet night (no protector in this mix): the witch revives the wolves' victim.
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: mayor.sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer", STEP);
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_revive");
    witch.send("witch_pass");

    await waitFor(() => room.state.phase === "day", STEP);
    for (const c of clients) c.send("day_vote", { targetId: mayor.sessionId }); // the village votes its mayor out
    await waitFor(() => room.state.phase === "reveal", STEP); // the day ends, his card reveal plays first…
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
    const done = r.checkedBy(detective.sessionId);
    assert.ok(done.has(villager.sessionId) && done.has(wolf.sessionId));
    assert.strictEqual(r.canInvestigate(detective.sessionId), true); // wild hunter + hunter left
    r.detectiveKnown.get(detective.sessionId).push({ a: byRole("hunter").sessionId, b: wolf.sessionId, same: false });
    assert.strictEqual(r.canInvestigate(detective.sessionId), false);

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

    await waitFor(() => room.state.phase === "day", 2 * STEP);
    assert.ok([...room.state.players.values()].every((p) => p.alive)); // Red Hood survived

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
    const byUid = Object.fromEntries(
      r.lastResults.map((x: any) => [x.uid, { role: x.role, won: x.won, minutes: x.minutes }]),
    );
    assert.deepStrictEqual(byUid[`uid${wolf}`], { role: "werewolf", won: false, minutes: 7 });
    assert.deepStrictEqual(byUid[`uid${quitter}`], { role: "seer", won: false, minutes: 5 });
    const winner = roles.indexOf("villager");
    assert.deepStrictEqual(byUid[`uid${winner}`], { role: "villager", won: true, minutes: 7 });

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
    room.state.phase = "judge";
    assert.deepStrictEqual(rights(seer), { talk: false, hear: true }); // the judge deciding: mics off
    room.state.phase = "day";
    room.state.players.get(seer.sessionId)!.alive = false;
    assert.deepStrictEqual(rights(seer), { talk: false, hear: true }); // the dead listen (by day)
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

  it("never lets the seer check the same player twice", async () => {
    const { room, byRole } = await startGame();
    const r = room as any;
    const [seer, wolf] = [byRole("seer"), byRole("werewolf")];
    r.known.set(seer.sessionId, { [wolf.sessionId]: "werewolf" }); // she saw him on an earlier night
    room.state.nightStep = "witch_seer";
    r.awake = new Set([seer.sessionId]);
    const refused = seer.waitForMessage("error");
    seer.send("seer_peek", { targetId: wolf.sessionId });
    assert.deepStrictEqual(await refused, { code: "already_seen" });
    assert.ok(r.awake.has(seer.sessionId)); // still her turn: she picks someone else
  });

  // ---- the special wolves ----

  it("shows the blue wolf as a simple villager the first time, himself the second, then never again", async () => {
    const mix = { wolves: 1, villagers: 1, seer: true, witch: false, protector: false, bluewolf: true };
    const { room, byRole } = await startGame(mix, 4);
    const r = room as any;
    const [seer, blue] = [byRole("seer"), byRole("bluewolf")];
    const peek = async () => {
      room.state.nightStep = "witch_seer";
      r.awake = new Set([seer.sessionId, "someone"]); // "someone" keeps the step open
      const result = seer.waitForMessage("seer_result");
      seer.send("seer_peek", { targetId: blue.sessionId });
      return ((await result) as any).role;
    };
    assert.strictEqual(await peek(), "villager");
    assert.strictEqual(await peek(), "bluewolf");
    r.awake = new Set([seer.sessionId, "someone"]);
    const refused = seer.waitForMessage("error");
    seer.send("seer_peek", { targetId: blue.sessionId });
    assert.deepStrictEqual(await refused, { code: "already_seen" });
  });

  it("father wolf infects the pack's victim; the black wolf silences someone for the day", async function () {
    this.timeout(60_000);
    const mix = { wolves: 1, villagers: 2, seer: false, witch: false, protector: false, fatherwolf: true, blackwolf: true };
    const { room, clients, roles, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [wolf, father, black] = [byRole("werewolf"), byRole("fatherwolf"), byRole("blackwolf")];
    const [prey, muted] = clients.filter((_, i) => roles[i] === "villager");

    await waitFor(() => room.state.nightStep === "wolves", STEP);
    for (const w of [wolf, father, black]) w.send("wolf_target", { targetId: prey.sessionId });
    const turn = father.waitForMessage("father_turn", STEP);
    await waitFor(() => room.state.nightStep === "wolf_powers", STEP);
    assert.deepStrictEqual(await turn, { victim: prey.sessionId });
    const infected = prey.waitForMessage("infected");
    const silenced = muted.waitForMessage("silenced");
    father.send("infect", { infect: true });
    black.send("silence", { targetId: muted.sessionId });
    await infected;
    await silenced;

    assert.strictEqual(room.state.players.get(prey.sessionId)?.alive, true); // turned, not killed
    assert.ok(r.isPack(prey.sessionId));
    assert.strictEqual(r.teamOf(prey.sessionId), "wolves");
    assert.strictEqual(r.roles.get(prey.sessionId), "villager"); // keeps his role (the seer sees a villager)
    assert.strictEqual(room.state.players.get(muted.sessionId)?.silenced, true);

    // The silenced player can't vote, and nobody can vote against him.
    r.state.phase = "day";
    muted.send("day_vote", { targetId: wolf.sessionId });
    wolf.send("day_vote", { targetId: muted.sessionId });
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(room.state.players.get(muted.sessionId)?.votedFor, "");
    assert.strictEqual(room.state.players.get(wolf.sessionId)?.votedFor, "");
  });

  it("green wolf steals a role with a right guess; the victim becomes a simple villager", async () => {
    const mix = { wolves: 1, villagers: 1, seer: true, witch: false, protector: false, greenwolf: true };
    const { room, byRole } = await startGame(mix, 4);
    const r = room as any;
    const [seer, green] = [byRole("seer"), byRole("greenwolf")];
    room.state.dayNumber = 2;
    r.wolfTarget = null;
    const turn = green.waitForMessage("green_turn");
    r.startGreenWolfStep(); // first of the night from night 2
    assert.deepStrictEqual(await turn, { left: 3 });
    // In the policeman's cage nothing is stolen: the guess is spent, and he doesn't learn if it was right.
    r.cages.set("a policeman", seer.sessionId);
    const kept = green.waitForMessage("green_result");
    green.send("green_guess", { targetId: seer.sessionId, role: "seer" });
    assert.deepStrictEqual(await kept, { targetId: seer.sessionId, role: "seer", right: false, left: 2, caged: true });
    assert.strictEqual(r.powerOf(seer.sessionId), "seer");
    r.cages.clear();
    r.startGreenWolfStep();
    const result = green.waitForMessage("green_result");
    green.send("green_guess", { targetId: seer.sessionId, role: "seer" });
    assert.deepStrictEqual(await result, { targetId: seer.sessionId, role: "seer", right: true, left: 1 });
    assert.strictEqual(r.powerOf(green.sessionId), "seer"); // wakes as the seer from now on…
    assert.strictEqual(r.teamOf(green.sessionId), "wolves"); // …still a wolf
    assert.strictEqual(r.roles.get(seer.sessionId), "villager");
  });

  it("red wolf's pick sleeps through his turn; the white wolf wins alone", async () => {
    const mix = { wolves: 1, villagers: 1, seer: true, witch: false, protector: false, redwolf: true, whitewolf: true };
    const { room, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [seer, red, white] = [byRole("seer"), byRole("redwolf"), byRole("whitewolf")];
    r.paralysed.set(red.sessionId, seer.sessionId);
    r.startWitchSeerStep();
    assert.ok(!r.awake.has(seer.sessionId));
    assert.ok(r.isPack(white.sessionId) && r.isPack(red.sessionId));
    assert.strictEqual(r.teamOf(white.sessionId), "whitewolf");

    for (const [id, p] of room.state.players) if (id !== white.sessionId) p.alive = false;
    r.endGameIfOver();
    assert.strictEqual(room.state.winner, "whitewolf");
  });

  it("starts with special wolves or a loner only, but never without a village or an enemy", async () => {
    const { roles } = await startGame({ wolves: 0, villagers: 2, seer: true, witch: false, protector: false, whitewolf: true, redwolf: true }, 4);
    assert.deepStrictEqual([...roles].sort(), ["redwolf", "seer", "villager", "whitewolf"]); // a villager made room

    const room = await colyseus.createRoom<WerewolfState>("werewolf", { wolves: 0, villagers: 3, seer: true, witch: false, protector: false });
    const clients: any[] = [];
    for (let i = 0; i < 4; i++) clients.push(await colyseus.connectTo(room));
    const refused = clients[0].waitForMessage("error");
    clients[0].send("start_game");
    assert.deepStrictEqual(await refused, { code: "bad_mix" }); // no wolf, no loner
    assert.strictEqual(room.state.phase, "lobby");
  });

  // ---- cupid, wild child, dragon, barbé, dictator, judge ----

  const SIX = {
    wolves: 1, villagers: 1, seer: false, witch: false, protector: false,
    cupid: true, wildchild: true, dragon: true, barbe: true, dictator: true, judge: true,
  };

  it("cupid's lovers die together and win together as the last two from opposite sides", async () => {
    const { room, byRole } = await startGame(SIX, 8);
    const r = room as any;
    assert.strictEqual(room.state.nightStep, "cupid"); // night 1 opens with cupid
    const [wolf, villager, judge] = [byRole("werewolf"), byRole("villager"), byRole("judge")];
    r.linkLovers(judge.sessionId, villager.sessionId);
    r.kill(judge.sessionId, "vote");
    assert.strictEqual(room.state.players.get(villager.sessionId)?.alive, false); // broken heart

    r.linkLovers(wolf.sessionId, byRole("dragon").sessionId);
    for (const [id, p] of room.state.players) p.alive = id === wolf.sessionId || id === byRole("dragon").sessionId;
    r.endGameIfOver();
    assert.strictEqual(room.state.winner, "lovers");
  });

  it("the wild child becomes a wolf when his model dies", async () => {
    const { room, byRole } = await startGame(SIX, 8);
    const r = room as any;
    const [child, model] = [byRole("wildchild"), byRole("barbe")];
    r.chooseModel(child.sessionId, model.sessionId);
    const turned = child.waitForMessage("wild_turned");
    r.kill(model.sessionId, "vote");
    await turned;
    assert.ok(r.isPack(child.sessionId));
    assert.strictEqual(r.teamOf(child.sessionId), "wolves");
  });

  it("the protector's shield breaks the red wolf's spell and stops an infection; a silenced player can't write", async () => {
    const mix = { ...NO_SPECIALS, wolves: 0, villagers: 2, fatherwolf: true, redwolf: true, protector: true, mayor: false };
    const { room, clients, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [father, protector, villager] = [byRole("fatherwolf"), byRole("protector"), byRole("villager")];
    assert.strictEqual(room.state.protectorShield, true); // on unless the host turns it off

    // The red wolf's spell on the player the protector then shields: gone, he plays tonight after all.
    r.paralysed.set(byRole("redwolf").sessionId, villager.sessionId);
    assert.strictEqual(room.state.nightStep, "protector");
    protector.send("protect", { targetId: villager.sessionId });
    await waitFor(() => r.protects.get(protector.sessionId) === villager.sessionId);
    assert.strictEqual(r.paralysed.size, 0);

    // The father bites the shielded player: no infection, and his one infection is spent.
    r.wolfTarget = villager.sessionId;
    room.state.nightStep = "wolf_powers";
    r.powerActors = new Set([father.sessionId]);
    father.send("infect", { infect: true });
    await waitFor(() => r.infectionUsed.has(father.sessionId));
    assert.strictEqual(r.infected.has(villager.sessionId), false);
    assert.strictEqual(r.wolfVictim, null); // (and he wasn't bitten either)

    // The black wolf's victim: no voice, no vote, and no writing in the chat.
    room.state.phase = "day";
    room.state.players.get(clients[0].sessionId)!.silenced = true;
    const refused = clients[0].waitForMessage("error");
    clients[0].send("chat", { text: "hello" });
    assert.deepStrictEqual(await refused, { code: "silenced_chat" });
    assert.strictEqual(r.chatLog.length, 0);
  });

  it("the dragon's fire comes back after a wolf; a dead mayor stands until his successor is named", async () => {
    const { room, clients, byRole } = await startGame(SIX, 8);
    const r = room as any;
    const [dragon, wolf, villager] = [byRole("dragon"), byRole("werewolf"), byRole("villager")];
    const state = (c: any) => room.state.players.get(c.sessionId)!;

    // A dead mayor keeps standing (as the hunter does until his shot) while he names his successor.
    room.state.mayorId = villager.sessionId;
    r.kill(villager.sessionId, "wolves");
    assert.deepStrictEqual([state(villager).alive, state(villager).aiming], [false, true]);
    r.revealsPending = 0;
    r.afterDeaths(() => {});
    assert.strictEqual(room.state.phase, "succession");
    assert.strictEqual(state(villager).aiming, true);
    const heir = clients.find((c: any) => c !== villager && c !== wolf && c !== dragon);
    villager.send("mayor_successor", { targetId: heir.sessionId });
    await waitFor(() => room.state.mayorId === heir.sessionId);
    assert.strictEqual(state(villager).aiming, false);

    // The dragon burns a wolf: his fire comes back.
    room.state.phase = "night";
    room.state.nightStep = "witch_seer";
    r.awake = new Set([dragon.sessionId, "someone"]);
    dragon.send("dragon_fire", { targetId: wolf.sessionId });
    await waitFor(() => r.dragonFires.get(dragon.sessionId) === wolf.sessionId);
    assert.ok(r.spent.has(dragon.sessionId));
    r.resolveNight();
    assert.strictEqual(state(wolf).alive, false);
    assert.ok(!r.spent.has(dragon.sessionId));
  });

  it("watching: not a game my own living seat is in; a VIP talking to the dead leaves a line in their chat", async () => {
    const { room, clients } = await startGame({ ...NO_SPECIALS, wolves: 1, villagers: 4, mayor: false }, 5);
    const r = room as any;
    // My seat is alive in this game: I come back to it, I don't watch (a living player would hear the dead).
    const mine = r.playerIds.get(clients[0].sessionId);
    await assert.rejects(colyseus.connectTo(room, { playerId: mine, spectator: true }), /seated/);

    const watcher = await colyseus.connectTo(room, { spectator: true });
    await waitFor(() => r.spectators.has(watcher.sessionId));
    watcher.send("spectator_speaking"); // not a VIP: nothing
    await new Promise((done) => setTimeout(done, 100));
    assert.strictEqual(r.deadChatLog.length, 0);
    r.vips.add(watcher.sessionId);
    const heard = watcher.waitForMessage("chat");
    watcher.send("spectator_speaking");
    const line: any = await heard;
    assert.deepStrictEqual([line.speaking, line.dead, line.text], [true, true, ""]);
    watcher.send("spectator_speaking"); // again within the minute: no second line
    await new Promise((done) => setTimeout(done, 100));
    assert.strictEqual(r.deadChatLog.length, 1);
  });

  it("the dragon burns once, at dawn", async () => {
    const { room, byRole } = await startGame(SIX, 8);
    const r = room as any;
    const [dragon, target] = [byRole("dragon"), byRole("villager")];
    room.state.nightStep = "witch_seer";
    r.awake = new Set([dragon.sessionId, "someone"]);
    dragon.send("dragon_fire", { targetId: target.sessionId });
    await waitFor(() => r.dragonFires.get(dragon.sessionId) === target.sessionId);
    assert.ok(r.spent.has(dragon.sessionId));
    r.resolveNight();
    assert.strictEqual(room.state.players.get(target.sessionId)?.alive, false);
  });

  it("the talking detective's verdict is told at dawn, under the day's title", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 3, detective: true, talkingDetective: true };
    const { room, clients, byRole } = await startGame(mix, 5);
    const r = room as any;
    const detective = byRole("detective");
    const [a, b] = clients.filter((c: any) => c !== detective);
    room.state.nightStep = "witch_seer";
    r.awake = new Set([detective.sessionId, "someone"]);
    detective.send("detective_check", { a: a.sessionId, b: b.sessionId });
    await waitFor(() => r.detectiveKnown.get(detective.sessionId)?.length === 1);
    const types = () => (r.publicLog as any[]).map((e) => e.type);
    assert.ok(!types().includes("detective_public")); // not during the night
    r.resolveNight();
    assert.deepStrictEqual(types().slice(types().indexOf("day"), types().indexOf("day") + 3), ["day", "village_wakes", "detective_public"]);
  });

  it("a dead hunter stands until he has shot", async () => {
    const { room, byRole } = await startGame({ ...NO_SPECIALS, wolves: 1, villagers: 3, hunter: true }, 5);
    const r = room as any;
    const [hunter, wolf] = [byRole("hunter"), byRole("werewolf")];
    const state = () => room.state.players.get(hunter.sessionId)!;
    r.kill(hunter.sessionId, "wolves");
    assert.deepStrictEqual([state().alive, state().aiming], [false, true]);
    r.revealsPending = 0;
    r.afterDeaths(() => {});
    assert.strictEqual(room.state.shooterId, hunter.sessionId);
    hunter.send("hunter_shoot", { targetId: wolf.sessionId });
    await waitFor(() => room.state.players.get(wolf.sessionId)?.alive === false);
    assert.strictEqual(state().aiming, false);
  });

  it("barbé unmasks a wolf; the dictator dies with an innocent", async () => {
    const { room, byRole } = await startGame(SIX, 8);
    const r = room as any;
    const [barbe, wolf, dictator, villager] = [byRole("barbe"), byRole("werewolf"), byRole("dictator"), byRole("villager")];
    room.state.phase = "day";
    barbe.send("barbe_ask", { targetId: wolf.sessionId });
    await waitFor(() => room.state.players.get(wolf.sessionId)?.alive === false);
    assert.strictEqual(room.state.players.get(barbe.sessionId)?.alive, true);
    // The village won (the only wolf died): check the dictator's rule directly.
    const r2 = (await startGame(SIX, 8)).room as any;
    const d = [...r2.roles].find(([, role]: any) => role === "dictator")[0];
    const v = [...r2.roles].find(([, role]: any) => role === "villager")[0];
    r2.state.phase = "dictator"; // his moment at daybreak
    r2.handleDictator({ sessionId: d }, { targetId: v });
    assert.strictEqual(r2.state.players.get(d)?.alive, false);
    assert.strictEqual(r2.state.players.get(v)?.alive, false);
    assert.ok(dictator && villager);
  });

  it("the judge orders one final revote that can't hit the spared player", async () => {
    const { room, clients, byRole } = await startGame(SIX, 8);
    const r = room as any;
    const [judge, target] = [byRole("judge"), byRole("villager")];
    room.state.phase = "day";
    for (const p of room.state.players.values()) p.votedFor = target.sessionId;
    r.resolveVote();
    assert.strictEqual(room.state.phase, "judge");
    assert.strictEqual(room.state.judgeTarget, target.sessionId);
    judge.send("judge", { revote: true });
    await waitFor(() => room.state.phase === "day");
    assert.strictEqual(room.state.spared, target.sessionId);
    clients[0].send("day_vote", { targetId: target.sessionId });
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(room.state.players.get(clients[0].sessionId)?.votedFor, "");
  });

  it("the dictator says yes at night and gets his moment at daybreak; otherwise it's lost", async () => {
    const { room, byRole } = await startGame({ ...SIX, mayor: false }, 8);
    const r = room as any;
    const dictator = byRole("dictator");
    room.state.nightStep = "witch_seer";
    r.awake = new Set([dictator.sessionId, "someone"]);
    dictator.send("dictator_ready", { use: true });
    await waitFor(() => r.armed.has(dictator.sessionId));
    r.startDay();
    assert.strictEqual(room.state.phase, "dictator");
    r.phaseTimer.clear();
    r.openDebate();
    assert.strictEqual(room.state.phase, "day");
    assert.strictEqual(room.state.mayor, false); // no election in this room
  });

  it("talking seer tells the village the role (not the player), at dawn; barbé's innocent shows as a villager", async () => {
    const { room, byRole } = await startGame({ ...SIX, seer: true, talkingSeer: true, maxPlayers: 9 }, 9);
    const r = room as any;
    const [seer, judge, barbe] = [byRole("seer"), byRole("judge"), byRole("barbe")];
    room.state.nightStep = "witch_seer";
    r.awake = new Set([seer.sessionId, "someone"]);
    seer.send("seer_peek", { targetId: judge.sessionId });
    await waitFor(() => r.seerNews.length === 1);
    const types = () => (r.publicLog as any[]).map((e) => e.type);
    assert.ok(!types().includes("seer_public")); // not during the night
    r.resolveNight();
    assert.deepStrictEqual(types().slice(types().indexOf("day"), types().indexOf("day") + 3), ["day", "village_wakes", "seer_public"]);
    const told = (r.publicLog as any[]).find((e) => e.type === "seer_public");
    assert.deepStrictEqual([told.role, told.name], ["judge", undefined]);

    room.state.phase = "day";
    barbe.send("barbe_ask", { targetId: judge.sessionId });
    await waitFor(() => room.state.players.get(barbe.sessionId)?.alive === false);
    assert.strictEqual(room.state.players.get(judge.sessionId)?.revealedRole, "villager");
  });

  it("tapping your vote again takes it back; the trickster shows a card to all at dawn", async () => {
    const { room, clients, byRole } = await startGame({ ...SIX, trickster: true, maxPlayers: 9 }, 9);
    const r = room as any;
    const [a, b] = clients;
    room.state.phase = "day";
    a.send("day_vote", { targetId: b.sessionId });
    await waitFor(() => room.state.players.get(a.sessionId)?.votedFor === b.sessionId);
    a.send("day_vote", { targetId: b.sessionId });
    await waitFor(() => room.state.players.get(a.sessionId)?.votedFor === "");

    const [trickster, judge] = [byRole("trickster"), byRole("judge")];
    room.state.phase = "night";
    room.state.dayNumber = 2;
    room.state.nightStep = "witch_seer";
    r.awake = new Set([trickster.sessionId, "someone"]);
    trickster.send("trick", { targetId: judge.sessionId });
    await waitFor(() => r.tricks.has(judge.sessionId));
    r.morningNews();
    assert.strictEqual(room.state.players.get(judge.sessionId)?.revealedRole, "judge");
  });

  it("a dead player who left gets his seat back when he returns", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", { ...SIX });
    const clients: any[] = [];
    for (let i = 0; i < 8; i++) clients.push(await colyseus.connectTo(room, { playerId: `dev${i}` }));
    const dealt = Promise.all(clients.map((c) => c.waitForMessage("role_assigned", STEP)));
    clients[0].send("start_game");
    const roles = (await dealt).map((m: any) => m.role);
    const r = room as any;
    const seat = roles.indexOf("judge"); // not the only wolf: the game must go on
    const quitter = clients[seat];
    const role = r.roles.get(quitter.sessionId);
    await quitter.leave(true); // leaving mid-game: he dies
    await waitFor(() => room.state.players.get(quitter.sessionId)?.alive === false && !r.clients.getById(quitter.sessionId));
    const back = await colyseus.connectTo(room, { playerId: `dev${seat}`, spectator: true });
    await waitFor(() => room.state.players.has(back.sessionId));
    assert.ok(!room.state.players.has(quitter.sessionId));
    assert.strictEqual(r.roles.get(back.sessionId), role);
    assert.strictEqual(room.state.players.get(back.sessionId)?.alive, false);
    assert.strictEqual([...room.state.players.keys()].indexOf(back.sessionId), seat); // same place in the circle
  });

  it("a bitten seer joins the pack at once and still looks that same night", async () => {
    const mix = { wolves: 1, villagers: 1, seer: true, witch: false, protector: false, fatherwolf: true };
    const { room, byRole } = await startGame(mix, 4);
    const r = room as any;
    const [seer, father, wolf] = [byRole("seer"), byRole("fatherwolf"), byRole("werewolf")];
    r.wolfVotes = new Map([[wolf.sessionId, seer.sessionId], [father.sessionId, seer.sessionId]]);
    r.wolfTarget = seer.sessionId;
    const told = seer.waitForMessage("infected");
    r.startWolfPowersStep();
    father.send("infect", { infect: true });
    await told; // right away, not at dawn
    assert.ok(r.isPack(seer.sessionId));
    await waitFor(() => room.state.nightStep === "witch_seer");
    assert.ok(r.awake.has(seer.sessionId)); // she still wakes as the seer tonight
  });

  // ---- fox, ancient, doubler, joker, raven, owl ----

  const SIX_MORE = {
    wolves: 1, villagers: 1, seer: true, witch: false, protector: false,
    fox: true, ancient: true, doubler: true, joker: true, raven: true, owl: true, maxPlayers: 9,
  };

  it("the fox smells three neighbours; a clean smell costs him his nose", async () => {
    const { room, byRole } = await startGame(SIX_MORE, 9);
    const r = room as any;
    const fox = byRole("fox");
    const seats = [...room.state.players.keys()];
    const wolfSeat = seats.indexOf(byRole("werewolf").sessionId);
    const smell = async (target: string) => {
      room.state.nightStep = "witch_seer";
      r.awake = new Set([fox.sessionId, "someone"]);
      const result = fox.waitForMessage("fox_result");
      fox.send("fox_smell", { targetId: target });
      return (await result) as any;
    };
    const nextToWolf = seats[(wolfSeat + 1) % seats.length];
    if (nextToWolf !== fox.sessionId) {
      const near = await smell(nextToWolf);
      assert.ok(near.wolf && near.ids.length === 3);
      assert.ok(!r.spent.has(fox.sessionId)); // a wolf found: he keeps his power
    }
    // Far from the wolf (3 seats away): clean, and he loses his power.
    const far = seats[(wolfSeat + 3) % seats.length];
    if (far !== fox.sessionId && !r.isPack(far)) {
      const clean = await smell(far);
      if (!clean.wolf) assert.ok(r.spent.has(fox.sessionId));
    }
  });

  it("the ancient survives one wolf attack; killed by the vote, the village loses its powers", async () => {
    const { room, byRole } = await startGame(SIX_MORE, 9);
    const r = room as any;
    const [ancient, wolf, seer] = [byRole("ancient"), byRole("werewolf"), byRole("seer")];
    r.wolfTarget = ancient.sessionId;
    r.wolfVotes = new Map([[wolf.sessionId, ancient.sessionId]]);
    r.finishWolfPowers();
    assert.strictEqual(r.wolfVictim, null); // first attack: he survives
    assert.ok(r.ancientUsed.has(ancient.sessionId));
    r.kill(ancient.sessionId, "vote");
    assert.strictEqual(r.powerOf(seer.sessionId), "villager"); // the seer's power is gone…
    assert.strictEqual(r.roles.get(seer.sessionId), "villager"); // …and her card with it: a simple villager now
  });

  it("the doubler copies a role; the joker sends someone else to die; the raven's +2 counts", async () => {
    const { room, clients, byRole } = await startGame(SIX_MORE, 9);
    const r = room as any;
    const [doubler, seer] = [byRole("doubler"), byRole("seer")];
    room.state.nightStep = "doubler";
    const copied = doubler.waitForMessage("doubler_result");
    doubler.send("copy", { targetId: seer.sessionId });
    assert.strictEqual(((await copied) as any).role, "seer");
    assert.strictEqual(r.powerOf(doubler.sessionId), "seer");

    const [joker, raven] = [byRole("joker"), byRole("raven")];
    room.state.players.get(joker.sessionId)!.voteBonus = 2; // the raven marked him
    assert.deepStrictEqual(r.withMarks([]), [joker.sessionId, joker.sessionId]);
    r.finishVote(joker.sessionId, [joker.sessionId]);
    assert.strictEqual(room.state.phase, "joker");
    joker.send("joker_pick", { targetId: raven.sessionId });
    await waitFor(() => room.state.players.get(raven.sessionId)?.alive === false);
    assert.strictEqual(room.state.players.get(joker.sessionId)?.alive, true);
    assert.ok(clients.length === 9);
  });

  it("god view is for admins only", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    await colyseus.connectTo(room);
    await assert.rejects(colyseus.connectTo(room, { admin: true, idToken: "not-an-admin" }), /admin/);
    assert.strictEqual(room.state.spectators, 0);
  });

  it("votes happen during the day; all voters but one cut the day to 30 seconds", async () => {
    const { room, clients } = await startGame({ ...ONE_OF_EACH, roundSeconds: 300 });
    const r = room as any;
    r.openDebate(); // a 5-minute day
    const voters = clients.filter((c: any) => room.state.players.get(c.sessionId)?.alive);
    for (const c of voters.slice(0, voters.length - 2)) c.send("day_vote", { targetId: voters[0].sessionId });
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(room.state.phaseEndsAt - Date.now() > 60_000); // not yet
    voters[voters.length - 2].send("day_vote", { targetId: voters[0].sessionId }); // all but one
    await waitFor(() => room.state.phaseEndsAt - Date.now() <= 30_000);
    assert.strictEqual(room.state.phase, "day");
  });

  it("the mayor election is a whole day; a tie leaves the village without a mayor; then night 1", async () => {
    const { room, clients } = await startGame({ ...ONE_OF_EACH, roundSeconds: 300 });
    const r = room as any;
    r.state.dayNumber = 0;
    r.startMayorVote(); // (as the game opens)
    assert.ok(room.state.phaseEndsAt - Date.now() > 250_000); // as long as a day
    const [a, b] = clients;
    a.send("day_vote", { targetId: b.sessionId });
    b.send("day_vote", { targetId: a.sessionId });
    await waitFor(() => room.state.players.get(b.sessionId)?.votedFor === a.sessionId);
    r.resolveMayor();
    assert.strictEqual(room.state.mayorId, ""); // 1–1: no mayor
    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(room.state.dayNumber, 1);
  });

  it("the host hands the room over to a player at the table; the black wolf may silence himself", async () => {
    const mix = { ...NO_SPECIALS, wolves: 0, villagers: 4, blackwolf: true, mayor: false };
    const { room, clients, byRole, opened } = await startGame(mix, 5);
    assert.strictEqual(opened, "night"); // no mayor: straight to the first night
    const r = room as any;
    const [host, other] = clients;
    other.send("transfer_host", { targetId: other.sessionId }); // not his to give
    host.send("transfer_host", { targetId: "nobody" });
    host.send("transfer_host", { targetId: other.sessionId });
    await waitFor(() => room.state.hostId === other.sessionId);
    assert.strictEqual(r.publicLog.at(-1).type, "new_host");

    const black = byRole("blackwolf");
    await waitFor(() => room.state.nightStep === "wolves");
    black.send("wolf_target", { targetId: clients.find((c: any) => c !== black).sessionId });
    await waitFor(() => room.state.nightStep === "wolf_powers", STEP);
    black.send("silence", { targetId: black.sessionId });
    await waitFor(() => r.silences.get(black.sessionId) === black.sessionId);
  });

  it("after the game, the host's new room takes the table: Play again gets in, even a private one", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room, { playerId: "host-device" });
    const other = await colyseus.connectTo(room, { playerId: "other-device" });
    (room as any).endGame(null);
    await waitFor(() => room.state.phase === "gameover");

    // His new room: private this time. A room someone else hosts doesn't count, nor a guest's word.
    const next = await colyseus.createRoom<WerewolfState>("werewolf", { roomType: "private" });
    await colyseus.connectTo(next, { playerId: "host-device" });
    const foreign = await colyseus.createRoom<WerewolfState>("werewolf", {});
    await colyseus.connectTo(foreign, { playerId: "someone-else" });
    host.send("recreated", { roomId: foreign.roomId });
    other.send("recreated", { roomId: next.roomId });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(room.state.nextRoomId, "");

    host.send("recreated", { roomId: next.roomId });
    await waitFor(() => room.state.nextRoomId === next.roomId);
    await assert.rejects(colyseus.connectTo(next, { playerId: "stranger" }), /private/);
    await colyseus.connectTo(next, { playerId: "other-device" }); // "Play again"
    assert.strictEqual(next.state.players.size, 2);

    // The old room: its host gone for good, the next player still there takes it.
    await host.leave();
    await waitFor(() => room.state.hostId === other.sessionId);
  });

  it("the host's invite takes his kick back; another player's doesn't", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room, { playerId: "host-device" });
    const other = await colyseus.connectTo(room, { playerId: "other-device" });
    const guest = await colyseus.connectTo(room, { playerId: "guest-device" });
    const r = room as any;
    r.members.set(host.sessionId, "host-uid").set(other.sessionId, "other-uid"); // as with accounts

    const kicked = guest.waitForMessage("kicked");
    host.send("kick", { targetId: guest.sessionId });
    await kicked;
    await waitFor(() => !room.state.players.has(guest.sessionId));
    other.send("invite", { uid: "guest-device" });
    await waitFor(() => r.invited.has("guest-device"));
    await assert.rejects(colyseus.connectTo(room, { playerId: "guest-device" }), /banned/);
    host.send("invite", { uid: "guest-device" });
    await waitFor(() => !r.banned.has("guest-device"));
    const back = await colyseus.connectTo(room, { playerId: "guest-device" });
    assert.ok(room.state.players.has(back.sessionId));
  });

  it("the dead and the spectators write to each other; the living never read it", async () => {
    const { room, clients } = await startGame();
    const heardByLiving: any[] = [];
    for (const c of clients) c.onMessage("chat", (m: any) => heardByLiving.push(m));
    const [w1, w2] = [
      await colyseus.connectTo(room, { spectator: true, playerId: "w1" }),
      await colyseus.connectTo(room, { spectator: true, playerId: "w2" }),
    ];
    await waitFor(() => room.state.spectators === 2);
    for (const w of [w1, w2]) w.onMessage("chat_history", () => {});
    const got = w2.waitForMessage("chat");
    w1.send("chat", { text: "who is the wolf?" });
    const line: any = await got;
    assert.strictEqual(line.text, "who is the wolf?");
    assert.strictEqual(line.dead, true);
    assert.strictEqual(line.from, w1.sessionId);
    assert.strictEqual(typeof line.avatar, "number"); // a line keeps its writer's look
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(heardByLiving, []);
    // Someone who comes to watch later reads what was said in the graveyard.
    const w3 = await colyseus.connectTo(room, { spectator: true, playerId: "w3" });
    const histories: any[] = [];
    w3.onMessage("chat_history", (h: any) => histories.push(h));
    await waitFor(() => histories.some((h) => h.some((l: any) => l.dead && l.text === "who is the wolf?")));
  });

  it("the ancient killed by the village: its special players become simple villagers, the wolves keep everything", async () => {
    const { room, byRole } = await startGame({ wolves: 1, villagers: 1, seer: true, witch: true, ancient: true, roundSeconds: 10 });
    const r = room as any;
    const [seer, witch, wolf, ancient] = [byRole("seer"), byRole("witch"), byRole("werewolf"), byRole("ancient")];
    const cursed = seer.waitForMessage("cursed");
    const card = seer.waitForMessage("role_assigned");
    r.kill(ancient.sessionId, "vote");
    await cursed;
    assert.strictEqual((await card).role, "villager"); // his card too
    assert.strictEqual(r.roles.get(seer.sessionId), "villager");
    assert.strictEqual(r.roles.get(witch.sessionId), "villager");
    assert.strictEqual(r.potions.has(witch.sessionId), false);
    assert.strictEqual(r.roles.get(wolf.sessionId), "werewolf");
    assert.strictEqual(r.roles.get(ancient.sessionId), "ancient"); // the dead show what they were
  });

  it("seat numbers are a room setting, off until the host turns them on", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const host = await colyseus.connectTo(room);
    assert.strictEqual(room.state.seatNumbers, false);
    host.send("settings", { seatNumbers: true });
    await waitFor(() => room.state.seatNumbers === true);
  });

  it("a day that ends on a tie gets 30 more seconds, once; still tied, nobody goes", async () => {
    const { room, clients } = await startGame();
    const r = room as any;
    const [a, b, c, d] = clients.map((x: any) => x.sessionId);
    r.openDebate(60_000); // (straight to a day)
    const events: any[] = [];
    clients[0].onMessage("event", (e: any) => events.push(e));
    room.state.players.get(a)!.votedFor = c;
    room.state.players.get(b)!.votedFor = d;
    r.resolveVote(); // the day's time is up: 1 against 1
    assert.strictEqual(room.state.phase, "day");
    assert.ok(room.state.phaseEndsAt - Date.now() > 25_000 && room.state.phaseEndsAt - Date.now() <= 30_000);
    await waitFor(() => events.some((e) => e.type === "vote_tie_extra"));
    r.resolveVote(); // still tied after the extra time
    assert.notStrictEqual(room.state.phase, "day");
    assert.strictEqual([...room.state.players.values()].filter((p) => !p.alive).length, 0);
  });

  it("the dead hear nothing of the night and read no more of the pack's chat, a dead wolf included", async () => {
    const { room, clients, byRole } = await startGame({ wolves: 2, villagers: 1, seer: true, witch: true, protector: false, roundSeconds: 10 });
    const r = room as any;
    const wolves = clients.filter((x: any) => r.isPack(x.sessionId));
    const [alive, dead] = wolves;
    const villager = byRole("villager");
    room.state.players.get(dead.sessionId)!.alive = false;
    room.state.players.get(villager.sessionId)!.alive = false;
    assert.strictEqual(room.state.phase, "night");
    assert.deepStrictEqual(r.voiceRightsOf(dead.sessionId), { talk: false, hear: false });
    assert.deepStrictEqual(r.voiceRightsOf(villager.sessionId), { talk: false, hear: false });
    assert.deepStrictEqual(r.voiceRightsOf(alive.sessionId), { talk: true, hear: true });
    const read: any[] = [];
    dead.onMessage("chat", (m: any) => read.push(m));
    villager.onMessage("chat", (m: any) => read.push(m));
    const got = alive.waitForMessage("chat");
    alive.send("chat", { text: "who do we eat?" });
    assert.strictEqual(((await got) as any).wolvesOnly, true);
    await new Promise((res) => setTimeout(res, 150));
    assert.deepStrictEqual(read.filter((m) => m.wolvesOnly), []);
    assert.ok(!r.chatFor(dead.sessionId).some((l: any) => l.wolvesOnly));
    assert.ok(r.chatFor(alive.sessionId).some((l: any) => l.wolvesOnly));
  });

  it("a doubler's copy plays his new role that same night, beside the player he copied", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 2, protector: true, doubler: true, mayor: false };
    const { room, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [doubler, protector, villager, wolf] = [byRole("doubler"), byRole("protector"), byRole("villager"), byRole("werewolf")];
    assert.strictEqual(room.state.nightStep, "doubler");
    doubler.send("copy", { targetId: protector.sessionId });
    // The protectors' step waits for both of them.
    await waitFor(() => room.state.nightStep === "protector");
    assert.deepStrictEqual([...r.acting].sort(), [doubler.sessionId, protector.sessionId].sort());
    doubler.send("protect", { targetId: villager.sessionId });
    await waitFor(() => r.protects.size === 1);
    assert.strictEqual(room.state.nightStep, "protector"); // the other one hasn't chosen yet
    protector.send("protect", { targetId: wolf.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    assert.strictEqual(r.protects.get(doubler.sessionId), villager.sessionId);
    assert.strictEqual(r.protects.get(protector.sessionId), wolf.sessionId);
  });

  it("the idiot survives his first vote, card shown; the seer wolf reads a card in secret; the hunter wolf shoots when he dies", async () => {
    const mix = { ...NO_SPECIALS, wolves: 0, villagers: 2, idiot: true, juniorwolf: true, seerwolf: true, talkingSeer: true, mayor: false };
    const { room, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [idiot, junior, seerWolf] = [byRole("idiot"), byRole("juniorwolf"), byRole("seerwolf")];
    const state = (c: any) => room.state.players.get(c.sessionId)!;

    // The seer wolf wakes with the seer's crowd: the exact card of someone outside the pack, and not a word to the village.
    r.startWitchSeerStep();
    assert.ok(r.awake.has(seerWolf.sessionId));
    seerWolf.send("seer_peek", { targetId: junior.sessionId }); // a packmate: refused
    const seen = seerWolf.waitForMessage("seer_result");
    seerWolf.send("seer_peek", { targetId: idiot.sessionId });
    assert.deepStrictEqual(await seen, { targetId: idiot.sessionId, role: "idiot", isWerewolf: false });
    assert.ok(!(r.publicLog as any[]).some((e) => e.type === "seer_public"));

    // The first vote against the idiot shows his card and lets him live; the next one kills him.
    r.completeVote(idiot.sessionId, [idiot.sessionId], "vote");
    assert.strictEqual(state(idiot).alive, true);
    assert.strictEqual(state(idiot).revealedRole, "idiot");
    assert.strictEqual(r.voteHistory.at(-1).excluded, null);
    assert.ok((r.publicLog as any[]).some((e) => e.type === "idiot_saved"));
    r.completeVote(idiot.sessionId, [idiot.sessionId], "vote");
    assert.strictEqual(state(idiot).alive, false);

    // The hunter wolf dies: a last shot, like the hunter's.
    r.kill(junior.sessionId, "vote");
    assert.ok(r.pendingShooters.includes(junior.sessionId));
    assert.strictEqual(state(junior).aiming, true);
  });

  it("the big bad wolf takes a second victim the witch can't save: from night 2, while the pack is whole", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 3, bigbadwolf: true, witch: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 6);
    const r = room as any;
    const [big, wolf, witch] = [byRole("bigbadwolf"), byRole("werewolf"), byRole("witch")];
    const [first, second] = clients.filter((_: any, i: number) => roles[i] === "villager");
    const alive = (c: any) => room.state.players.get(c.sessionId)!.alive;

    // Night 1: he only hunts with the pack.
    const quiet = witch.waitForMessage("witch_turn");
    r.endWolvesStep();
    assert.strictEqual(room.state.nightStep, "witch_seer");
    await quiet;

    // Night 2: after the hunt, a victim of his own — not the pack's pick.
    room.state.dayNumber = 2;
    r.wolfVotes.set(wolf.sessionId, first.sessionId);
    const turn = big.waitForMessage("bigbad_turn");
    r.endWolvesStep();
    assert.strictEqual(room.state.nightStep, "big_bad_wolf");
    assert.deepStrictEqual(await turn, { blocked: first.sessionId });
    const shown = witch.waitForMessage("witch_turn");
    big.send("bigbad_kill", { targetId: first.sessionId }); // refused
    big.send("bigbad_kill", { targetId: second.sessionId });
    // The witch is shown the pack's victim only: she saves him, and the other one dies all the same.
    assert.strictEqual(((await shown) as any).victim, first.sessionId);
    witch.send("witch_revive");
    witch.send("witch_pass");
    await waitFor(() => !alive(second));
    assert.strictEqual(alive(first), true);

    // A wolf is dead: no second victim any more.
    room.state.players.get(wolf.sessionId)!.alive = false;
    room.state.dayNumber = 4;
    r.endWolvesStep();
    assert.notStrictEqual(room.state.nightStep, "big_bad_wolf");
  });

  it("the two brothers know each other, can't be infected, the survivor shoots; the knight's sword takes the first wolf on his left", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 1, fatherwolf: true, knight: true, brothers: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 6);
    const r = room as any;
    assert.strictEqual(roles.filter((x: string) => x === "brothers").length, 2); // one switch, two cards
    const [a, b] = clients.filter((_: any, i: number) => roles[i] === "brothers");
    const [father, knight] = [byRole("fatherwolf"), byRole("knight")];
    const alive = (id: string) => room.state.players.get(id)!.alive;
    assert.deepStrictEqual(r.brothersOf(a.sessionId), [b.sessionId]);
    assert.deepStrictEqual(r.privateLogs.get(a.sessionId)[0].brothers, [room.state.players.get(b.sessionId)!.name]);
    assert.strictEqual(r.isHunter(b.sessionId), false);

    // The father's bite doesn't turn a brother: he dies of it, and the infection is spent.
    r.wolfTarget = a.sessionId;
    r.wolfVotes.set(father.sessionId, a.sessionId);
    room.state.nightStep = "wolf_powers";
    r.powerActors = new Set([father.sessionId]);
    father.send("infect", { infect: true });
    await waitFor(() => !alive(a.sessionId));
    assert.ok(r.infectionUsed.has(father.sessionId) && !r.infected.has(a.sessionId));
    // His brother takes up the gun: he'll shoot when he dies.
    assert.strictEqual(r.isHunter(b.sessionId), true);
    assert.ok(r.privateLogs.get(b.sessionId).some((e: any) => e.type === "brother_avenger"));

    // The wolves kill the knight: the first living wolf after him round the table dies of his sword that same morning.
    const seats = [...room.state.players.keys()];
    const from = seats.indexOf(knight.sessionId);
    const [cut, spared] = [...seats.slice(from + 1), ...seats.slice(0, from)].filter((id) => r.isPack(id));
    r.wolfVictim = knight.sessionId;
    r.resolveNight();
    assert.strictEqual(alive(knight.sessionId), false);
    assert.strictEqual(alive(cut), false);
    assert.strictEqual(alive(spared), true);
    assert.ok((r.publicLog as any[]).some((e) => e.type === "death" && e.cause === "knight"));
  });

  it("the wolfdog picks his side on night 1; the two brothers leave a small table together", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 2, wolfdog: true, mayor: false };
    const { room, byRole } = await startGame(mix, 4);
    const r = room as any;
    const [dog, wolf] = [byRole("wolfdog"), byRole("werewolf")];
    assert.strictEqual(room.state.nightStep, "wolfdog"); // before anyone else
    assert.strictEqual(r.teamOf(dog.sessionId), "village"); // …and saying nothing leaves him there
    const told = dog.waitForMessage("role_assigned");
    dog.send("wolfdog_side", { wolves: true });
    assert.deepStrictEqual(((await told) as any).pack.sort(), [dog.sessionId, wolf.sessionId].sort());
    assert.strictEqual(r.teamOf(dog.sessionId), "wolves");
    assert.strictEqual(room.state.nightStep, "wolves"); // he hunts with them this very night
    assert.ok(r.privateLogs.get(wolf.sessionId).some((e: any) => e.type === "wolfdog_joined"));

    // Four seats for five cards: the brothers go together (never one without the other), a villager takes the free seat.
    const small = await colyseus.createRoom<WerewolfState>("werewolf", { ...NO_SPECIALS, wolves: 2, villagers: 0, seer: true, brothers: true });
    for (let i = 0; i < 4; i++) await colyseus.connectTo(small);
    (small as any).assignRoles();
    assert.deepStrictEqual([...(small as any).roles.values()].sort(), ["seer", "villager", "werewolf", "werewolf"]);
  });

  it("the policeman's cage: no power for the caged player, a caged wolf sits the hunt out, nothing bites him", async () => {
    const mix = { ...NO_SPECIALS, wolves: 2, villagers: 1, policeman: true, seer: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [policeman, seer] = [byRole("policeman"), byRole("seer")];
    const [caged, free] = clients.filter((_: any, i: number) => roles[i] === "werewolf");
    assert.strictEqual(room.state.nightStep, "policeman"); // before the powers and the hunt
    policeman.send("cage", { targetId: policeman.sessionId }); // never himself
    const told = caged.waitForMessage("caged");
    policeman.send("cage", { targetId: caged.sessionId });
    await told;
    await waitFor(() => room.state.nightStep === "wolves");

    // The caged wolf's vote doesn't count; nothing can bite (or infect) him tonight.
    caged.send("wolf_target", { targetId: seer.sessionId });
    free.send("wolf_target", { targetId: policeman.sessionId });
    await waitFor(() => r.wolfVotes.size === 1);
    assert.ok(!r.wolfVotes.has(caged.sessionId));
    assert.ok(!r.holders("werewolf").includes(caged.sessionId));
    assert.strictEqual(r.bites(caged.sessionId), false);
    assert.deepStrictEqual(r.nightNews, ["caged"]);

    // The next night: out of the cage, and never the same player twice in a row.
    r.startNight();
    assert.strictEqual(room.state.nightStep, "policeman");
    assert.ok(r.holders("werewolf").includes(caged.sessionId));
    const refused = policeman.waitForMessage("error");
    policeman.send("cage", { targetId: caged.sessionId });
    assert.deepStrictEqual(await refused, { code: "same_cage" });
  });

  it("the cat dies at a wolf's house; the little girl shows the hunter a side; the shepherd counts sheep, the rabbit chocolates", async () => {
    const mix = {
      ...NO_SPECIALS, wolves: 1, villagers: 1, cat: true, littlegirl: true, shepherd: true, rabbit: true, hunter: true,
      whitewolf: true, talkingShepherd: true, mayor: false,
    };
    const { room, byRole } = await startGame(mix, 8);
    const r = room as any;
    const [cat, girl, shepherd, rabbit, hunter, wolf, villager, white] =
      ["cat", "littlegirl", "shepherd", "rabbit", "hunter", "werewolf", "villager", "whitewolf"].map(byRole);
    const state = (c: any) => room.state.players.get(c.sessionId)!;
    assert.strictEqual(room.state.extraOptions, "talkingShepherd");

    r.startWitchSeerStep();
    for (const c of [cat, girl, shepherd, rabbit]) assert.ok(r.awake.has(c.sessionId));
    // The hunter (and only he) learns which side the little girl's pick is on. For these four, the white wolf is a wolf.
    const shown = hunter.waitForMessage("girl_known");
    girl.send("girl_pick", { targetId: white.sessionId });
    assert.deepStrictEqual(await shown, { [white.sessionId]: true });
    // Three sheep, two chocolates, each to a different player; the cat picks the wrong house.
    shepherd.send("gifts", { targets: [white.sessionId, villager.sessionId] }); // not three: refused
    shepherd.send("gifts", { targets: [white.sessionId, villager.sessionId, hunter.sessionId] });
    rabbit.send("gifts", { targets: [wolf.sessionId, villager.sessionId] });
    cat.send("cat_sleep", { targetId: white.sessionId });
    await waitFor(() => !state(cat).alive); // everyone done: dawn

    const log = r.publicLog as any[];
    const death = log.find((e) => e.type === "death" && e.cause === "cat");
    assert.strictEqual(death.house, state(white).name); // everyone learns whose house it was
    // The wolf kept one sheep: the village hears the shepherd's count (a room setting), not the rabbit's.
    assert.deepStrictEqual(log.filter((e) => e.type === "gifts_public").map((e) => [e.role, e.count]), [["shepherd", 2]]);
    const mine = (c: any) => r.privateLogs.get(c.sessionId).find((e: any) => e.type === "gifts_back");
    assert.deepStrictEqual([mine(shepherd).count, mine(shepherd).lost, mine(rabbit).count], [2, false, 1]);

    // All three sheep back: no wolf found, and the shepherd's power is gone. No living hunter: the little girl sleeps.
    r.gifts = [{ by: shepherd.sessionId, role: "shepherd", count: 3 }];
    r.catVisits.clear();
    r.resolveNight();
    assert.ok(r.spent.has(shepherd.sessionId));
    state(hunter).alive = false;
    r.startWitchSeerStep();
    assert.ok(!r.awake.has(girl.sessionId) && !r.awake.has(shepherd.sessionId) && r.awake.has(rabbit.sessionId));
  });

  it("the priest's holy water kills a wolf or the priest; the alchemist's poison; the mirror sends a villager's attack back", async () => {
    const mix = { ...NO_SPECIALS, wolves: 2, villagers: 1, priest: true, alchemist: true, mirror: true, whitewolf: true, mayor: false };
    const { room, byRole } = await startGame(mix, 7);
    const r = room as any;
    const [priest, alchemist, mirror, wolf, villager, white] =
      ["priest", "alchemist", "mirror", "werewolf", "villager", "whitewolf"].map(byRole);
    const state = (c: any) => room.state.players.get(c.sessionId)!;
    const causes = () => Object.fromEntries((r.publicLog as any[]).filter((e) => e.type === "death").map((e) => [e.name, e.cause]));

    // Never on the first night.
    r.startWitchSeerStep();
    assert.ok(!r.awake.has(priest.sessionId) && !r.awake.has(alchemist.sessionId));

    // Night 2. The alchemist poisons the mirror: it comes back at him. The priest throws at a villager: the priest dies.
    room.state.dayNumber = 2;
    r.startWitchSeerStep();
    assert.ok(r.awake.has(priest.sessionId) && r.awake.has(alchemist.sessionId));
    r.infected.add(alchemist.sessionId); // (a wolf now: the mirror sends his poison back all the same)
    alchemist.send("flask", { targetId: mirror.sessionId });
    priest.send("flask", { targetId: villager.sessionId });
    await waitFor(() => !state(priest).alive);
    assert.deepStrictEqual([state(alchemist).alive, state(mirror).alive, state(villager).alive], [false, true, true]);
    assert.strictEqual(causes()[state(alchemist).name], "mirror");
    assert.strictEqual(causes()[state(priest).name], "priest_fail");
    assert.ok(r.spent.has(mirror.sessionId) && r.spent.has(priest.sessionId)); // one reflection, one flask

    // (Both back on their feet, to try the other outcomes.)
    state(alchemist).alive = state(priest).alive = true;
    // On a wolf, the holy water kills. A protector's ward stops the alchemist's poison.
    r.protects = new Map([["someone", villager.sessionId]]);
    r.flasks = [
      { by: priest.sessionId, target: wolf.sessionId, role: "priest" },
      { by: alchemist.sessionId, target: villager.sessionId, role: "alchemist" },
    ];
    r.resolveNight();
    assert.deepStrictEqual([state(wolf).alive, state(priest).alive, state(villager).alive], [false, true, true]);
    assert.strictEqual(causes()[state(wolf).name], "priest");
    // The wild hunter's trap on the poisoned player: the alchemist dies instead.
    r.protects = new Map();
    r.traps = new Set([villager.sessionId]);
    r.flasks = [{ by: alchemist.sessionId, target: villager.sessionId, role: "alchemist" }];
    r.resolveNight();
    assert.deepStrictEqual([state(alchemist).alive, state(villager).alive], [false, true]);
    // For the holy water the white wolf is a wolf like the others.
    r.traps = new Set();
    r.flasks = [{ by: priest.sessionId, target: white.sessionId, role: "priest" }];
    r.resolveNight();
    assert.deepStrictEqual([state(white).alive, state(priest).alive], [false, true]);
  });

  it("the puppet takes the first dead pack wolf's role; the servant takes a dead village player's, fresh", async () => {
    const mix = { ...NO_SPECIALS, wolves: 2, villagers: 1, servant: true, puppet: true, seer: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 6);
    const r = room as any;
    const [servant, puppet, seer] = ["servant", "puppet", "seer"].map(byRole);
    const [wolf, other] = clients.filter((_: any, i: number) => roles[i] === "werewolf");
    assert.strictEqual(r.teamOf(puppet.sessionId), "village"); // until a wolf dies
    r.startWitchSeerStep();
    assert.ok(!r.awake.has(servant.sessionId)); // nobody is dead: nothing to take over

    // The first wolf of the pack dies: the puppet becomes that wolf, and the pack is told.
    const turned = puppet.waitForMessage("puppet_turned");
    r.kill(wolf.sessionId, "vote");
    assert.strictEqual(((await turned) as any).role, "werewolf");
    assert.deepStrictEqual([r.roles.get(puppet.sessionId), r.teamOf(puppet.sessionId)], ["werewolf", "wolves"]);
    assert.ok(r.privateLogs.get(other.sessionId).some((e: any) => e.type === "puppet_joined"));

    // A village player dies: his role is the servant's to take, never the dead wolf's. Hers from the next night.
    r.kill(seer.sessionId, "vote");
    assert.deepStrictEqual(r.heirlooms(), [seer.sessionId]);
    r.startWitchSeerStep();
    assert.ok(r.awake.has(servant.sessionId));
    servant.send("inherit", { targetId: wolf.sessionId }); // refused
    const hers = servant.waitForMessage("inherited");
    servant.send("inherit", { targetId: seer.sessionId });
    assert.deepStrictEqual(await hers, { targetId: seer.sessionId, role: "seer" });
    assert.deepStrictEqual([r.powerOf(servant.sessionId), r.teamOf(servant.sessionId)], ["seer", "village"]);
    assert.ok(r.holders("seer").includes(servant.sessionId));
  });

  it("the chameleon wolf, voted against while another is put out, takes the role of the first villager who voted him", async () => {
    const mix = { ...NO_SPECIALS, wolves: 0, villagers: 2, chameleonwolf: true, seer: true, hunter: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [chameleon, seer, hunter] = ["chameleonwolf", "seer", "hunter"].map(byRole);
    const [out, villager] = clients.filter((_: any, i: number) => roles[i] === "villager");
    const state = (c: any) => room.state.players.get(c.sessionId)!;
    room.state.phase = "day";
    r.clearVotes();
    const vote = async (voter: any, target: any) => {
      voter.send("day_vote", { targetId: target.sessionId });
      await waitFor(() => state(voter).votedFor === target.sessionId);
    };
    await vote(seer, chameleon); // the first to vote him
    await vote(hunter, chameleon);
    for (const voter of [out, villager, chameleon]) await vote(voter, out);

    const robbed = seer.waitForMessage("role_stolen");
    r.resolveVote();
    assert.deepStrictEqual(await robbed, { by: "chameleonwolf" });
    assert.strictEqual(state(out).alive, false);
    assert.deepStrictEqual([r.powerOf(chameleon.sessionId), r.teamOf(chameleon.sessionId)], ["seer", "wolves"]);
    assert.deepStrictEqual([r.roles.get(seer.sessionId), r.powerOf(hunter.sessionId)], ["villager", "hunter"]);
    assert.strictEqual(r.idsWithRole("chameleonwolf").length, 0); // once
  });

  it("the alien names roles by day: right kills at once, a wrong guess too many kills him", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 2, alien: true, seer: true, mayor: false };
    const { room, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [alien, seer, villager] = ["alien", "seer", "villager"].map(byRole);
    const state = (c: any) => room.state.players.get(c.sessionId)!;
    const causes = () => Object.fromEntries((r.publicLog as any[]).filter((e) => e.type === "death").map((e) => [e.name, e.cause]));
    const guess = async (target: any, role: string) => {
      const answer = alien.waitForMessage("alien_result");
      alien.send("alien_guess", { targetId: target.sessionId, role });
      return answer;
    };
    assert.strictEqual(r.teamOf(alien.sessionId), "alien"); // a side of his own
    room.state.phase = "day";
    alien.send("alien_guess", { targetId: seer.sessionId, role: "piper" }); // not in this game: refused
    alien.send("alien_guess", { targetId: seer.sessionId, role: "alien" }); // never another loner
    // Wrong, on a village role: one of his five is gone. As often as he likes in a day.
    assert.deepStrictEqual(await guess(seer, "villager"), { targetId: seer.sessionId, role: "villager", right: false, village: 4, wolves: 3 });
    assert.strictEqual((await guess(villager, "werewolf") as any).wolves, 2);
    // Right: that player dies at once.
    assert.strictEqual((await guess(seer, "seer") as any).right, true);
    assert.strictEqual(state(seer).alive, false);
    assert.strictEqual(causes()[state(seer).name], "alien");
    // No wrong guess left on wolves: the next one is his own death.
    room.state.phase = "day";
    r.alienLeft.get(alien.sessionId).wolves = 0;
    await guess(villager, "werewolf");
    assert.strictEqual(state(alien).alive, false);
    assert.strictEqual(causes()[state(alien).name], "alien_fail");
  });

  it("the bomber's bomb goes round at daybreak and blows on its last holder; a loner alone at last wins", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 3, bomber: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [bomber, wolf] = ["bomber", "werewolf"].map(byRole);
    const [first, second, third] = clients.filter((_: any, i: number) => roles[i] === "villager");
    const state = (c: any) => room.state.players.get(c.sessionId)!;

    r.startWitchSeerStep();
    assert.ok(!r.awake.has(bomber.sessionId)); // never on the first night
    room.state.dayNumber = 2;
    r.startWitchSeerStep();
    bomber.send("bomb_plant", { targetId: first.sessionId, count: 1 }); // two holders at least
    bomber.send("bomb_plant", { targetId: first.sessionId, count: 2 });
    // Daybreak: everyone sees who holds it. Only he can hand it on; on its second holder it blows.
    await waitFor(() => room.state.phase === "bomb");
    assert.strictEqual(room.state.bombHolder, first.sessionId);
    second.send("bomb_pass", { targetId: third.sessionId }); // not his to pass
    first.send("bomb_pass", { targetId: wolf.sessionId });
    await waitFor(() => !state(wolf).alive);
    assert.ok((r.publicLog as any[]).some((e) => e.type === "death" && e.cause === "bomb"));

    // A longer one: it can't go straight back to the player it came from.
    r.bombs = [{ target: first.sessionId, count: 3 }];
    r.nextBomb();
    first.send("bomb_pass", { targetId: second.sessionId });
    await waitFor(() => room.state.bombHolder === second.sessionId);
    assert.ok(!r.bombTargets(second.sessionId).includes(first.sessionId));
    second.send("bomb_pass", { targetId: first.sessionId }); // refused
    second.send("bomb_pass", { targetId: third.sessionId });
    await waitFor(() => !state(third).alive);

    // The bomber, the last one standing: his game.
    for (const c of [first, second]) state(c).alive = false;
    assert.strictEqual(r.endGameIfOver(), true);
    assert.strictEqual(room.state.winner, "bomber");
  });

  it("the piper charms two a night and wins when all are charmed; the guitarist's song; neither bite nor poison kills them", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 2, piper: true, guitarist: true, witch: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 6);
    const r = room as any;
    const [piper, guitarist, witch, wolf] = ["piper", "guitarist", "witch", "werewolf"].map(byRole);
    const [first, second] = clients.filter((_: any, i: number) => roles[i] === "villager");
    const state = (c: any) => room.state.players.get(c.sessionId)!;
    // The pack's bite comes to nothing on them, and nobody is told (the narrator only says an attack failed).
    assert.strictEqual(r.bites(piper.sessionId), false);
    assert.deepStrictEqual(r.nightNews, ["immune"]);

    room.state.dayNumber = 2;
    r.startWitchSeerStep();
    for (const c of [piper, guitarist, witch]) assert.ok(r.awake.has(c.sessionId));
    const spell = first.waitForMessage("charmed");
    piper.send("charm", { targets: [first.sessionId] }); // two at a time while two are left
    piper.send("charm", { targets: [first.sessionId, second.sessionId] });
    assert.deepStrictEqual(((await spell) as any).ids.sort(), [first.sessionId, second.sessionId].sort()); // they see each other
    // The guitarist names a role and two players: the wolf is one of them, so both die. The witch's poison does nothing to the piper.
    guitarist.send("strum", { targets: [wolf.sessionId, first.sessionId], role: "werewolf" });
    witch.send("witch_poison", { targetId: piper.sessionId });
    await waitFor(() => !state(wolf).alive);
    assert.deepStrictEqual([state(first).alive, state(piper).alive], [false, true]);
    assert.ok((r.publicLog as any[]).filter((e) => e.type === "death").every((e) => e.cause === "guitarist"));

    // Everyone still alive is under the spell: the piper wins at once.
    assert.strictEqual(r.endGameIfOver(), false);
    r.charmed.add(guitarist.sessionId).add(witch.sessionId);
    assert.strictEqual(r.endGameIfOver(), true);
    assert.strictEqual(room.state.winner, "piper");
  });

  it("the killer stabs from night 2, after the wolves: the witch never sees it, a ward stops him, the trap turns on him; no bite kills him or the bomber", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 3, killer: true, bomber: true, witch: true, mayor: false };
    const { room, clients, roles, byRole } = await startGame(mix, 7);
    const r = room as any;
    const [killer, bomber, witch] = ["killer", "bomber", "witch"].map(byRole);
    const [first, second, third] = clients.filter((_: any, i: number) => roles[i] === "villager");
    const alive = (c: any) => room.state.players.get(c.sessionId)!.alive;
    assert.strictEqual(r.teamOf(killer.sessionId), "killer"); // a side of his own
    assert.deepStrictEqual([r.bites(killer.sessionId), r.bites(bomber.sessionId)], [false, false]);
    r.nightNews = [];

    const early = witch.waitForMessage("witch_turn");
    r.startKillerStep(); // night 1: he sleeps
    assert.notStrictEqual(room.state.nightStep, "killer");
    await early;
    room.state.dayNumber = 2;
    r.startKillerStep();
    assert.strictEqual(room.state.nightStep, "killer");
    const turn = witch.waitForMessage("witch_turn");
    killer.send("knife", { targetId: killer.sessionId }); // not himself
    killer.send("knife", { targetId: first.sessionId });
    assert.strictEqual(((await turn) as any).victim, null); // the witch is never shown his victim
    r.resolveNight();
    assert.strictEqual(alive(first), false);
    assert.ok((r.publicLog as any[]).some((e) => e.type === "death" && e.cause === "killer"));

    // A protector's ward stops the knife (the narrator's "came to nothing"); on the trapped player he dies himself.
    r.knives = new Map([[killer.sessionId, second.sessionId]]);
    r.protects = new Map([[third.sessionId, second.sessionId]]);
    r.nightNews = [];
    r.resolveNight();
    assert.strictEqual(alive(second), true);
    assert.deepStrictEqual(r.nightNews, ["protected"]);
    r.knives = new Map([[killer.sessionId, third.sessionId]]);
    r.protects = new Map();
    r.traps = new Set([third.sessionId]);
    r.resolveNight();
    assert.deepStrictEqual([alive(third), alive(killer)], [true, false]);
  });

  it("the red wolf's spell does nothing to a loner, and nobody is told; a ward stops the witch's poison, an infected protector's too", async () => {
    const mix = { ...NO_SPECIALS, wolves: 0, villagers: 1, redwolf: true, alien: true, protector: true, witch: true, mayor: false };
    const { room, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [red, alien, protector, witch, villager] = ["redwolf", "alien", "protector", "witch", "villager"].map(byRole);
    room.state.dayNumber = 2;
    r.startRedWolfStep();
    red.send("paralyse", { targetId: alien.sessionId });
    await waitFor(() => r.paralysed.size === 1);
    assert.strictEqual(r.isParalysed(alien.sessionId), false);
    assert.ok(r.privateLogs.get(red.sessionId).some((e: any) => e.type === "paralysed_confirm"));
    assert.ok(!(r.privateLogs.get(alien.sessionId) ?? []).some((e: any) => e.type === "paralysed"));

    r.infect(protector.sessionId);
    assert.ok(r.holders("protector").includes(protector.sessionId)); // infected, he still guards
    r.protects = new Map([[protector.sessionId, villager.sessionId]]);
    r.poisons = new Map([[witch.sessionId, villager.sessionId]]);
    r.resolveNight();
    assert.strictEqual(room.state.players.get(villager.sessionId)!.alive, true);
  });

  it("the servant takes an infected player's role, not his infection; a dead wolfdog shows the side he chose", async () => {
    const mix = { ...NO_SPECIALS, wolves: 1, villagers: 1, servant: true, seer: true, wolfdog: true, mayor: false };
    const { room, clients, byRole } = await startGame(mix, 5);
    const r = room as any;
    const [servant, seer, wolfdog] = ["servant", "seer", "wolfdog"].map(byRole);
    const reveals: any[] = [];
    clients[0].onMessage("death_reveal", (m: any) => reveals.push(m));
    r.infect(seer.sessionId);
    r.kill(seer.sessionId, "vote");
    assert.deepStrictEqual(r.heirlooms(), [seer.sessionId]);
    room.state.dayNumber = 2;
    r.startWitchSeerStep();
    const hers = servant.waitForMessage("inherited");
    servant.send("inherit", { targetId: seer.sessionId });
    await hers;
    assert.deepStrictEqual(
      [r.powerOf(servant.sessionId), r.teamOf(servant.sessionId), r.infected.has(servant.sessionId)],
      ["seer", "village", false],
    );

    r.turned.add(wolfdog.sessionId); // he went with the wolves
    r.kill(wolfdog.sessionId, "vote");
    await waitFor(() => reveals.some((m) => m.id === wolfdog.sessionId));
    assert.strictEqual(reveals.find((m) => m.id === wolfdog.sessionId).wolfdogWolves, true);
    assert.strictEqual(reveals.find((m) => m.id === seer.sessionId).wolfdogWolves, undefined);
  });

  it("the mayor election is in the vote log; the host can close the day's chat to the living; emojis by day, the dead's among the dead", async () => {
    const { room, clients, roles } = await startGame({ ...ONE_OF_EACH, mayor: true, noLivingChat: true }, 5, () => 1);
    const r = room as any;
    assert.deepStrictEqual([r.mayorVote.mayor, r.mayorVote.excluded], [true, clients[1].sessionId]);
    assert.strictEqual(Object.keys(r.mayorVote.ballots).length, 5);
    assert.strictEqual(r.voteHistory.length, 0); // not a day's vote

    const wolf = clients[roles.indexOf("werewolf")];
    const [writer, reader] = clients.filter((c: any) => c !== wolf);
    const lines = () => r.chatLog.length + r.wolfChatLog.length;
    wolf.send("chat", { text: "tonight?" }); // night: the pack keeps its chat
    await waitFor(() => r.wolfChatLog.length === 1);
    room.state.phase = "day";
    const refused = writer.waitForMessage("error");
    writer.send("chat", { text: "hello" });
    assert.deepStrictEqual(await refused, { code: "living_chat_off" });
    assert.strictEqual(lines(), 1);

    const seen: any[] = [];
    const mine: any[] = [];
    reader.onMessage("emoji", (m: any) => seen.push(m));
    writer.onMessage("emoji", (m: any) => mine.push(m));
    writer.send("emoji", { id: "heart" });
    await waitFor(() => seen.length === 1);
    room.state.phase = "night";
    r.emojiAt.clear();
    writer.send("emoji", { id: "gg" }); // the living show nothing at night
    await new Promise((done) => setTimeout(done, 200));
    room.state.players.get(writer.sessionId)!.alive = false;
    writer.send("emoji", { id: "sob" }); // dead: for the dead only
    await waitFor(() => mine.length === 2);
    assert.deepStrictEqual(seen, [{ from: writer.sessionId, id: "heart" }]);
    assert.deepStrictEqual(mine.map((m) => m.id), ["heart", "sob"]);
  });

  it("holds a dropped spectator's place a while, as a player's seat", async () => {
    const { room } = await startGame();
    const watcher = await colyseus.connectTo(room, { spectator: true, playerId: "watcher" });
    await waitFor(() => room.state.spectators === 1);
    watcher.reconnection.enabled = false; // like an app in the background: the connection goes
    await watcher.leave(false);
    await new Promise((done) => setTimeout(done, 300));
    assert.ok((room as any).spectators.has(watcher.sessionId));
  });
});
