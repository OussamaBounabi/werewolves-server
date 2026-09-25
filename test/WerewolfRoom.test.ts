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

describe("WerewolfRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startGame(options: object = {}) {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", options);
    const clients: any[] = [];
    for (let i = 0; i < 5; i++) clients.push(await colyseus.connectTo(room)); // join order: clients[0] is host
    const rolesPromise = Promise.all(clients.map((c) => c.waitForMessage("role_assigned")));
    clients[0].send("start_game");
    const roles = (await rolesPromise).map((m: any) => m.role as string);
    const byRole = (role: string) => clients[roles.indexOf(role)];
    return { room, clients, roles, byRole };
  }

  it("deals one of each special role and starts the night with the protector", async () => {
    const { room, roles } = await startGame();
    assert.deepStrictEqual([...roles].sort(), ["protector", "seer", "villager", "werewolf", "witch"]);
    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(room.state.nightStep, "protector");
  });

  it("uses the host's role mix, dropping villagers first when fewer players join", async () => {
    const roles = { werewolf: 2, villager: 3, seer: true, witch: true, protector: true }; // 8 seats
    const { room, roles: dealt } = await startGame({ roles });
    assert.strictEqual(room.maxClients, 8);
    assert.deepStrictEqual([...dealt].sort(), ["protector", "seer", "werewolf", "werewolf", "witch"]);
  });

  it("lets a dead mayor name his successor", async function () {
    this.timeout(30_000); // waits out the 10s debate
    const { room, clients, roles, byRole } = await startGame({
      roles: { werewolf: 1, villager: 2, seer: true, witch: true, protector: false },
    });
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const [mayor, heir] = clients.filter((_, i) => roles[i] === "villager");

    // Quiet night (no protector in this mix): the witch revives the wolves' victim.
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: mayor.sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer");
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_revive");
    witch.send("witch_pass");
    await waitFor(() => room.state.phase === "mayor");

    for (const c of clients) c.send("day_vote", { targetId: mayor.sessionId });
    await waitFor(() => room.state.mayorId === mayor.sessionId);

    await waitFor(() => room.state.phase === "vote", 15_000);
    for (const c of clients) c.send("day_vote", { targetId: mayor.sessionId }); // the village votes its mayor out
    await waitFor(() => room.state.phase === "succession");
    assert.strictEqual(room.state.successionFrom, mayor.sessionId);

    const handover = heir.waitForMessage("mayor_result");
    mayor.send("mayor_successor", { targetId: heir.sessionId });
    assert.deepStrictEqual(await handover, { mayorId: heir.sessionId, successor: true });
    assert.strictEqual(room.state.mayorId, heir.sessionId);
    assert.strictEqual(room.state.phase, "night");
  });

  it("gives the host their test role", async () => {
    const { roles } = await startGame({ testRole: "witch" });
    assert.strictEqual(roles[0], "witch");
  });

  it("plays a night: protector → wolves → witch sees the victim and revives it", async () => {
    const { room, byRole } = await startGame();
    const wolf = byRole("werewolf"), witch = byRole("witch"), seer = byRole("seer");
    const villager = byRole("villager"), protector = byRole("protector");

    protector.send("protect", { targetId: protector.sessionId });
    await room.waitForNextPatch();
    assert.strictEqual(room.state.nightStep, "wolves");

    const witchTurn = witch.waitForMessage("witch_turn");
    wolf.send("wolf_target", { targetId: villager.sessionId });
    assert.deepStrictEqual(await witchTurn, { victim: villager.sessionId, canPoison: true });
    assert.strictEqual(room.state.nightStep, "witch_seer");

    const peek = seer.waitForMessage("seer_result");
    seer.send("seer_peek", { targetId: wolf.sessionId });
    assert.strictEqual((await peek).isWerewolf, true);

    const night = villager.waitForMessage("night_result");
    witch.send("witch_revive");
    witch.send("witch_pass");
    assert.deepStrictEqual(await night, { deaths: [], saved: true });
    assert.strictEqual(room.state.phase, "mayor"); // first night over → the village elects a mayor
  });

  it("elects a mayor whose exclusion vote counts twice", async function () {
    this.timeout(30_000); // waits out the 10s debate
    const { room, byRole } = await startGame();
    const [wolf, witch, seer] = [byRole("werewolf"), byRole("witch"), byRole("seer")];
    const [villager, protector] = [byRole("villager"), byRole("protector")];

    // A quick night where nobody dies.
    protector.send("protect", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "wolves");
    wolf.send("wolf_target", { targetId: villager.sessionId });
    await waitFor(() => room.state.nightStep === "witch_seer");
    seer.send("seer_peek", { targetId: wolf.sessionId });
    witch.send("witch_pass");
    await waitFor(() => room.state.phase === "mayor");

    const elected = villager.waitForMessage("mayor_result");
    for (const c of [wolf, witch, seer, villager, protector]) c.send("day_vote", { targetId: villager.sessionId });
    assert.deepStrictEqual(await elected, { mayorId: villager.sessionId });
    assert.strictEqual(room.state.mayorId, villager.sessionId);

    await waitFor(() => room.state.phase === "vote", 15_000);
    const result = villager.waitForMessage("vote_result");
    villager.send("day_vote", { targetId: wolf.sessionId }); // mayor: 2 votes
    seer.send("day_vote", { targetId: witch.sessionId });
    witch.send("day_vote", { targetId: protector.sessionId });
    protector.send("day_vote", { targetId: seer.sessionId });
    wolf.send("day_vote", { targetId: wolf.sessionId }); // voting for yourself is allowed
    const r: any = await result;
    assert.strictEqual(r.excluded, wolf.sessionId);
    assert.strictEqual(r.votes, 3); // mayor ×2 + the wolf himself
    assert.strictEqual(room.state.winner, "villagers");
  });

  it("hides the revive when the wolves attack the protected player", async () => {
    const { byRole } = await startGame();
    const wolf = byRole("werewolf"), witch = byRole("witch"), villager = byRole("villager");

    byRole("protector").send("protect", { targetId: villager.sessionId });
    const witchTurn = witch.waitForMessage("witch_turn");
    await new Promise((r) => setTimeout(r, 50));
    wolf.send("wolf_target", { targetId: villager.sessionId });
    assert.deepStrictEqual(await witchTurn, { victim: null, canPoison: true });
  });
});
