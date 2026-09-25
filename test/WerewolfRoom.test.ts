import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WerewolfState } from "../src/rooms/schema/WerewolfState.js";

describe("WerewolfRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  async function startGame(options: object = {}) {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", options);
    const clients = [];
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
    assert.strictEqual(room.state.phase, "day");
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
