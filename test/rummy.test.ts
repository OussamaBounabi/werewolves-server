import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { jokerFits, meldOf } from "../src/rummy.js";

// Card numbers: suit * 13 + rank - 1 (♠ 0, ♥ 1, ♦ 2, ♣ 3), +52 for the second deck, 104+ jokers.
const c = (rank: number, suit: number, deck = 0) => deck * 52 + suit * 13 + rank - 1;
const J = 104;

describe("rummy melds", () => {
  it("counts sets and runs the Algerian way", () => {
    assert.deepStrictEqual(meldOf([c(6, 0), c(7, 0), c(8, 0)])?.points, 21);
    assert.deepStrictEqual(meldOf([c(1, 1), c(2, 1), c(3, 1)])?.points, 6); // low ace: 1
    assert.deepStrictEqual(meldOf([c(12, 1), c(13, 1), c(1, 1)])?.points, 31); // Q-K-A: 10+10+11
    assert.deepStrictEqual(meldOf([c(1, 0), c(1, 1), c(1, 2)])?.points, 33); // A-A-A: 11 each
    assert.deepStrictEqual(meldOf([c(13, 0), c(13, 1), c(13, 2), c(13, 3)])?.points, 40);
  });

  it("refuses what isn't a meld", () => {
    assert.strictEqual(meldOf([c(5, 0), c(5, 0, 1), c(5, 1)]), null); // same suit twice in a set
    assert.strictEqual(meldOf([c(13, 0), c(1, 0), c(2, 0)]), null); // no K-A-2
    assert.strictEqual(meldOf([c(4, 0), c(5, 1), c(6, 0)]), null);
    assert.strictEqual(meldOf([c(4, 0), J, J + 1]), null); // two real cards at least
  });

  it("puts jokers in the gaps, then on the high end, and lets a real card take their place", () => {
    const run = meldOf([c(5, 2), J, c(7, 2)])!;
    assert.deepStrictEqual(run.cards, [c(5, 2), J, c(7, 2)]);
    assert.strictEqual(run.points, 12); // the joker doesn't count
    assert.ok(jokerFits(run, 1, c(6, 2)));
    assert.ok(!jokerFits(run, 1, c(6, 1)));
    assert.deepStrictEqual(meldOf([c(12, 3), c(13, 3), J])!.cards, [c(12, 3), c(13, 3), J]); // J is the ace
    assert.ok(jokerFits(meldOf([c(12, 3), c(13, 3), J])!, 2, c(1, 3)));
    const set = meldOf([c(9, 0), c(9, 1), J])!;
    assert.ok(jokerFits(set, 2, c(9, 3)) && !jokerFits(set, 2, c(9, 0, 1)));
  });
});

describe("RummyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
  beforeEach(async () => await colyseus.cleanup());

  it("deals 15 to the first player, 14 to the other, and passes the turn on a discard", async () => {
    const room = await colyseus.createRoom("rummy", {});
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    // The latest view each one got; next() waits for one that passes the check.
    const views = new Map<any, any>();
    const errors: string[] = [];
    for (const client of [a, b]) client.onMessage("rummy", (v: any) => views.set(client, v));
    b.onMessage("rummy_error", (e: any) => errors.push(e.code));
    const next = async (client: any, check: (v: any) => boolean) => {
      const deadline = Date.now() + 3000;
      while (!(views.get(client) && check(views.get(client)))) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
      return views.get(client);
    };
    a.send("start_game");
    const sa = await next(a, (v) => v.phase === "playing");
    const sb = await next(b, (v) => v.phase === "playing");
    assert.strictEqual(sa.phase, "playing");
    assert.strictEqual(sa.hand.length, 15);
    assert.strictEqual(sb.hand.length, 14);
    assert.strictEqual(sa.threshold, 101);
    assert.strictEqual(sa.turn, sa.me);

    b.send("draw"); // not his turn: nothing happens
    a.send("discard", { card: sa.hand[0] });
    const after = await next(b, (v) => v.discardTop >= 0);
    assert.strictEqual(after.turn, sb.me);
    assert.strictEqual(after.stage, "draw");
    assert.strictEqual(after.discardTop, sa.hand[0]);

    b.send("take");
    const took = await next(b, (v) => v.taken >= 0);
    assert.strictEqual(took.taken, sa.hand[0]);
    b.send("discard", { card: took.hand[0] }); // the taken card must be laid down first
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(errors, ["use_taken"]);
    b.send("untake");
    const back = await next(b, (v) => v.stage === "draw" && v.taken === -1);
    assert.strictEqual(back.stage, "draw");
    assert.strictEqual(back.hand.length, 14);
  });

  // Sets up b's turn (draw stage) with this hand and this card on the discard pile.
  async function rigged(hand: number[], top: number, opened: boolean) {
    const room: any = await colyseus.createRoom("rummy", {});
    const a = await colyseus.connectTo(room);
    const b = await colyseus.connectTo(room);
    const errors: string[] = [];
    b.onMessage("rummy", () => {});
    b.onMessage("rummy_error", (e: any) => errors.push(e.code));
    a.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    room.hands.set(b.sessionId, [...hand]);
    room.discard = [top];
    room.turn = b.sessionId;
    room.stage = "draw";
    if (opened) room.opened.add(b.sessionId);
    const send = async (type: string, msg?: object) => {
      b.send(type, msg);
      await new Promise((r) => setTimeout(r, 150));
    };
    return { room, b, errors, send };
  }

  it("lays nothing without the taken card — or the player's own copy of it", async () => {
    const other = [c(9, 0), c(9, 1), c(9, 2)];
    const { room, b, errors, send } = await rigged([c(5, 3, 1), c(5, 0), c(5, 1), ...other, c(2, 2)], c(5, 3), true);
    await send("take");
    await send("stage", { cards: other });
    await send("lay");
    assert.deepStrictEqual(errors, ["use_taken"]);
    await send("stage", { cards: [c(5, 3, 1), c(5, 0), c(5, 1)] }); // his own 5♣
    await send("lay");
    assert.strictEqual(room.taken, null);
    assert.ok(room.hands.get(b.sessionId).includes(c(5, 3))); // the taken 5♣ stays in his hand
  });

  it("takes a discarded joker to rummy: lays all 14 cards and throws the joker", async () => {
    const hand = [
      c(9, 0), c(10, 0), c(11, 0), c(12, 0), c(13, 0),
      c(9, 1), c(10, 1), c(11, 1), c(12, 1), c(13, 1),
      c(7, 0), c(7, 1), c(7, 2), c(7, 3),
    ];
    const { room, b, errors, send } = await rigged(hand, J, false);
    await send("take");
    for (const m of [hand.slice(0, 5), hand.slice(5, 10), hand.slice(10)]) await send("stage", { cards: m });
    await send("lay");
    assert.deepStrictEqual(room.hands.get(b.sessionId), [J]);
    await send("discard", { card: J });
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(room.lastRound.joker, true);
    assert.strictEqual(Object.values(room.lastRound.penalties)[0], 400); // never opened, doubled
  });
});
