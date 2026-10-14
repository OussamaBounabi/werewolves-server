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

  it("2 vs 2, blocked: the lightest single hand wins for its team, not the lighter pair; shared by both sides, nobody", async () => {
    const room: any = await colyseus.createRoom("domino", { teams: true, target: 250 });
    const host = await colyseus.connectTo(room);
    host.onMessage("domino", () => {});
    host.onMessage("domino_fx", () => {});
    for (let i = 0; i < 3; i++) host.send("add_bot", { level: "easy" });
    await new Promise((r) => setTimeout(r, 200));
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    const tile = (a: number, b: number) => TILES.findIndex((t) => t[0] === a && t[1] === b);
    const ids = room.seats.map((s: any) => s.id); // seats 0 and 2 against 1 and 3
    const hands = (...tiles: number[][]) => tiles.forEach((t, i) => room.hands.set(ids[i], t));
    // The lightest hand (1 dot) sits with the heavier pair (1 + 12 against 2 + 3): its team takes the round.
    hands([tile(0, 1)], [tile(0, 2)], [tile(6, 6)], [tile(1, 2)]);
    room.endRound("", true);
    assert.deepStrictEqual([room.history.at(-1).winner, room.history.at(-1).points, room.teamScores], [ids[0], 5, [5, 0]]);
    // Two dots on each side: nobody scores.
    hands([tile(0, 2)], [tile(1, 1)], [tile(6, 6)], [tile(5, 5)]);
    room.endRound("", true);
    assert.deepStrictEqual([room.history.at(-1).winner, room.history.at(-1).points, room.teamScores], ["", 0, [5, 0]]);
  });

  it("a spectator sees the table, never a hand, and can't play", async () => {
    const room: any = await colyseus.createRoom("domino", {});
    const host = await colyseus.connectTo(room);
    const guest = await colyseus.connectTo(room);
    for (const c of [host, guest]) {
      c.onMessage("domino", () => {});
      c.onMessage("domino_fx", () => {});
    }
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(colyseus.connectTo(room), /started/);
    const watcher: any = await colyseus.connectTo(room, { spectator: true });
    let seen: any = null;
    watcher.onMessage("domino", (s: any) => (seen = s));
    watcher.onMessage("domino_fx", () => {});
    watcher.onMessage("domino_error", () => {});
    watcher.send("draw"); // not his to do (and everyone is told the table again)
    while (!seen) await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(seen.hand, []);
    assert.deepStrictEqual(seen.seats.map((s: any) => s.cards), [7, 7]);
    assert.ok(!seen.seats.some((s: any) => s.id === seen.me));
    assert.strictEqual(seen.spectators, 1);
    assert.strictEqual(room.pile.length, 14, "he drew nothing");
    await watcher.leave();
    while (room.spectators.size > 0) await new Promise((r) => setTimeout(r, 20));
    room.disconnect();
  });

  it("tells the room list its game started, and gives a returning player his seat back from the bot", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const room: any = await colyseus.createRoom("domino", {});
    const host = await colyseus.connectTo(room, { playerId: "host-device" });
    const guest = await colyseus.connectTo(room, { playerId: "guest-device" });
    for (const c of [host, guest]) {
      c.onMessage("domino", () => {});
      c.onMessage("domino_fx", () => {});
    }
    assert.strictEqual(room.metadata.started, false);
    host.send("start_game");
    while (room.phase !== "playing" || !room.metadata.started) await sleep(20); // the list knows without anyone leaving
    const seatId = guest.sessionId;
    await guest.leave();
    while (!room.seat(seatId).bot) await sleep(20); // a bot plays for him
    // Back through the "watch" door: he's recognised, and sits where he was.
    const back: any = await colyseus.connectTo(room, { playerId: "guest-device", spectator: true });
    let seen: any = null;
    back.onMessage("domino", (s: any) => (seen = s));
    back.onMessage("domino_fx", () => {});
    back.onMessage("domino_error", () => {});
    back.send("ready"); // (nothing to do now: everyone is told the table again)
    while (!seen) await sleep(20);
    assert.strictEqual(seen.me, seatId, "his seat's id, not his new connection's");
    assert.strictEqual(room.seat(seatId).bot, null);
    assert.strictEqual(room.spectators.size, 0);
    assert.ok(seen.hand.length > 0);
    assert.deepStrictEqual(seen.hand, room.hands.get(seatId));
    assert.strictEqual(seen.seats.find((s: any) => s.id === seatId).bot, "");
    // Someone else can only watch.
    const other: any = await colyseus.connectTo(room, { playerId: "other-device", spectator: true });
    while (room.spectators.size !== 1) await sleep(20);
    await other.leave();
    room.disconnect();
  });
});
