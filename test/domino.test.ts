import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { botMove, ends, opener, place, sidesFor, TILES, type Line } from "../src/domino.js";
import { DominoRoom } from "../src/rooms/DominoRoom.js";

const T = (a: number, b: number) => TILES.findIndex(([lo, hi]) => lo === Math.min(a, b) && hi === Math.max(a, b));

describe("dominoes", () => {
  it("grows the line at both ends", () => {
    const line: Line = { first: null, left: [], right: [] };
    place(line, T(6, 6), "right");
    assert.deepStrictEqual(ends(line), [6, 6]);
    assert.deepStrictEqual(sidesFor(line, T(6, 2)), ["left", "right"]);
    place(line, T(6, 2), "left");
    place(line, T(6, 4), "right");
    assert.deepStrictEqual(ends(line), [2, 4]);
    assert.deepStrictEqual(sidesFor(line, T(1, 3)), []);
    assert.deepStrictEqual(sidesFor(line, T(2, 4)), ["left", "right"]);
  });

  it("starts with the highest double, and the bot dumps its heaviest tile", () => {
    const hands = new Map([["a", [T(5, 5), T(0, 6)]], ["b", [T(6, 6), T(1, 2)]]]);
    assert.deepStrictEqual(opener(hands), { id: "b", tile: T(6, 6) });
    const line: Line = { first: T(4, 4), left: [], right: [] };
    const move = botMove({ level: "normal", hand: [T(4, 1), T(4, 6), T(2, 2)], line, forced: null, opponentsLack: new Set(), partnerLacks: new Set() });
    assert.strictEqual(move?.tile, T(4, 6));
  });
});

describe("DominoRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    DominoRoom.botSpeed = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    DominoRoom.botSpeed = 1;
    await colyseus.shutdown();
  });

  for (const teams of [false, true]) {
    it(`bots play whole rounds${teams ? " in 2 vs 2" : " (3 players, with a pile)"}, every tile accounted for`, async () => {
      const room: any = await colyseus.createRoom("domino", { teams, target: 100 });
      const host = await colyseus.connectTo(room);
      host.onMessage("domino", () => {});
      host.onMessage("domino_fx", () => {});
      for (let i = 0; i < (teams ? 3 : 2); i++) host.send("add_bot", { level: ["easy", "normal", "hard"][i] });
      await new Promise((r) => setTimeout(r, 200));
      host.send("start_game");
      while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(room.pile.length, teams ? 0 : 7);
      room.becomeBot(host.sessionId);
      const deadline = Date.now() + 40_000;
      while (room.history.length < 2 && room.phase !== "gameover" && Date.now() < deadline) {
        if (room.phase === "playing") {
          const line = room.line;
          const all = [...room.pile, ...[...room.hands.values()].flat(), ...(line.first === null ? [] : [line.first]), ...line.left.map((p: any) => p.tile), ...line.right.map((p: any) => p.tile)];
          assert.strictEqual(new Set(all).size, 28);
          assert.strictEqual(all.length, 28);
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(room.history.length >= 1, "a round ended");
      const r = room.history[0];
      assert.ok(r.winner === "" || r.points >= 0);
    });
  }
});
