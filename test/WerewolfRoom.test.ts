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
const STEP = 12_000; // a night step lasts 10s now that the wolves' step never ends early

describe("WerewolfRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startGame(options: object = ONE_OF_EACH) {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", options);
    const clients: any[] = [];
    for (let i = 0; i < 5; i++) clients.push(await colyseus.connectTo(room)); // join order: clients[0] is host
    const rolesPromise = Promise.all(clients.map((c) => c.waitForMessage("role_assigned")));
    clients[0].send("start_game");
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
    await quitter.leave(true); // on purpose
    const g: any = await gone;
    assert.strictEqual(g.id, quitter.sessionId);
    assert.strictEqual(g.reason, "quit");
    assert.strictEqual(room.state.players.get(quitter.sessionId)?.alive, false);

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
    await waitFor(() => room.state.phase === "succession");
    assert.strictEqual(room.state.successionFrom, mayor.sessionId);

    const handover = heir.waitForMessage("mayor_result");
    mayor.send("mayor_successor", { targetId: heir.sessionId });
    assert.deepStrictEqual(await handover, { mayorId: heir.sessionId, successor: true });
    assert.strictEqual(room.state.mayorId, heir.sessionId);
    assert.strictEqual(room.state.phase, "night");
  });
});
