import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { WerewolfState } from "../src/rooms/schema/WerewolfState.js";

describe("WerewolfRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  it("assigns one role per player and starts the night phase", async () => {
    const room = await colyseus.createRoom<WerewolfState>("werewolf", {});
    const clients = await Promise.all([1, 2, 3, 4, 5].map(() => colyseus.connectTo(room)));

    const roles = await Promise.all([
      ...clients.map((c) => c.waitForMessage("role_assigned")),
      (async () => {
        clients[0].send("start_game");
      })(),
    ]);
    roles.pop(); // drop the send()'s own undefined result

    const counts: Record<string, number> = {};
    for (const { role } of roles as any[]) counts[role] = (counts[role] ?? 0) + 1;

    assert.strictEqual(room.state.phase, "night");
    assert.strictEqual(counts.werewolf, 1);
    assert.strictEqual(counts.seer, 1);
    assert.strictEqual(counts.witch, 1);
    assert.strictEqual(counts.villager, 2);
  });
});
