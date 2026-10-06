import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { botMove, DIE_SAMPLE_MS, HOME, movable, square, target, throwDie, victims, type Board } from "../src/ludo.js";
import { LudoRoom } from "../src/rooms/LudoRoom.js";

const nobody = () => false;

describe("ludo", () => {
  it("leaves the base on a 6, goes home on the exact number", () => {
    assert.strictEqual(target(-1, 5), null);
    assert.strictEqual(target(-1, 6), 0);
    assert.strictEqual(target(50, 6), HOME);
    assert.strictEqual(target(53, 4), null);
    assert.strictEqual(target(HOME, 1), null);
    assert.deepStrictEqual(movable([-1, -1, 10, 10], 6), [0, 2]); // pawns standing together count once
    assert.strictEqual(square(1, 0), 13);
    assert.strictEqual(square(3, 20), (39 + 20) % 52);
    assert.strictEqual(square(0, 51), -1); // the home column
  });

  it("catches on plain squares only, never a partner", () => {
    // Red's pawn at progress 5 is on square 5; green's pawn at progress 44 is on square (13+44)%52 = 5.
    const board: Board = new Map([[0, [5]], [1, [44]], [2, [-1]]]);
    assert.deepStrictEqual(victims(board, 1, 44, nobody), [{ color: 0, pawn: 0 }]); // green lands on red
    assert.deepStrictEqual(victims(board, 2, 31, nobody), [{ color: 0, pawn: 0 }, { color: 1, pawn: 0 }]); // (26+31)%52 = 5
    assert.deepStrictEqual(victims(board, 2, 31, (c) => c === 0), [{ color: 1, pawn: 0 }]);
    assert.deepStrictEqual(victims(new Map([[0, [8]], [2, [34]]]), 2, 34, nobody), []); // square 8 is a star
    // A bot takes the catch.
    assert.strictEqual(botMove("normal", new Map([[0, [3, 20]], [1, [-1, (52 + 5 - 13) % 52]]]), 0, 2, nobody), 0);
  });
});

describe("the die", () => {
  it("flies, bounces off the frame, lands and stops on the board", () => {
    for (const [x, y, dx, dy, power] of [[7.5, 7.5, 1, 0, 1], [1, 1, -1, -1, 0.2], [14, 7, 0.3, -1, 0.7], [5, 12, 0, 0, 0.5]]) {
      const t = throwDie(x, y, dx, dy, power);
      const n = t.path.length / 3;
      assert.ok(n >= 10 && t.ms >= 300 && t.ms <= 3000, `${n} samples, ${t.ms} ms`);
      assert.strictEqual(t.ms, Math.round((n - 1) * DIE_SAMPLE_MS));
      assert.ok(t.path.some((v, i) => i % 3 === 2 && v > 0.4), "it flies");
      for (let i = 0; i < n; i++) {
        const [px, py, pz] = t.path.slice(i * 3, i * 3 + 3);
        assert.ok(px >= 0.79 && px <= 14.21 && py >= 0.79 && py <= 14.21 && pz >= 0, `sample ${i}: ${px}, ${py}, ${pz}`);
      }
      assert.deepStrictEqual(t.path.slice(-3), [t.x, t.y, 0]);
    }
  });
});

describe("LudoRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    LudoRoom.botSpeed = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    LudoRoom.botSpeed = 1;
    await colyseus.shutdown();
  });

  for (const [teams, capture, pawns] of [[false, "auto", 2], [true, "ask", 2]] as const) {
    it(`bots race to the end${teams ? " in 2 vs 2" : " (3 players)"}, capture ${capture}`, async () => {
      const room: any = await colyseus.createRoom("ludo", { teams, capture, pawns, turnSeconds: 10 });
      room.setSimulationInterval(() => {}, 5); // the room's clock ticks faster: the bots' timers fire sooner
      const host = await colyseus.connectTo(room);
      host.onMessage("ludo", () => {});
      host.onMessage("ludo_fx", () => {});
      for (let i = 0; i < (teams ? 3 : 2); i++) host.send("add_bot", { level: ["easy", "normal", "hard"][i] });
      await new Promise((r) => setTimeout(r, 200));
      host.send("start_game");
      while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(room.seats.map((s: any) => s.color), teams ? [0, 1, 2, 3] : [0, 1, 2]);
      host.send("auto", { on: true }); // the bot plays for me
      const deadline = Date.now() + 50_000;
      while (room.phase !== "gameover" && Date.now() < deadline) {
        for (const s of room.seats) {
          assert.strictEqual(s.pawns.length, pawns);
          assert.ok(s.pawns.every((p: number) => p >= -1 && p <= HOME));
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.strictEqual(room.phase, "gameover", "the race ended");
      assert.strictEqual(new Set(room.places).size, room.seats.length);
      const first = room.seats.find((s: any) => s.id === room.places[0]);
      assert.ok(first.pawns.every((p: number) => p === HOME));
    });
  }
});
