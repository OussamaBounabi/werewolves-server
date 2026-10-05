import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { DEFAULT_RULES, isJoker, jokerFits, layError, meldOf, openingError } from "../src/rummy.js";
import { planTurn, wantsDiscard, type BotView } from "../src/rummyBot.js";
import { RummyRoom } from "../src/rooms/RummyRoom.js";

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

describe("rummy table rules", () => {
  it("lays at most one joker per meld and 5 cards per meld; adds stay free", () => {
    assert.strictEqual(layError(meldOf([c(5, 0), J, J + 1, c(8, 0)])!, DEFAULT_RULES), "two_jokers");
    assert.strictEqual(layError(meldOf([3, 4, 5, 6, 7, 8].map((r) => c(r, 1)))!, DEFAULT_RULES), "too_long");
    assert.strictEqual(layError(meldOf([3, 4, 5, 6, 7].map((r) => c(r, 1)))!, DEFAULT_RULES), "");
    assert.strictEqual(layError(meldOf([c(5, 0), J, J + 1, c(8, 0)])!, { ...DEFAULT_RULES, oneJoker: false }), "");
  });

  it("opens only with a run without a joker, and jokers count only if the table says so", () => {
    const sets = [meldOf([c(6, 0), c(6, 1), c(6, 2)])!, meldOf([c(10, 0), c(10, 1), c(10, 2), c(10, 3)])!];
    assert.strictEqual(openingError(sets, 51, 51, DEFAULT_RULES), "need_run"); // 18 + 40 but no run
    assert.strictEqual(openingError(sets, 51, 51, { ...DEFAULT_RULES, needRun: false }), "");
    const jokerRun = meldOf([c(9, 2), J, c(11, 2)])!;
    assert.strictEqual(openingError([...sets, jokerRun], 51, 51, DEFAULT_RULES), "need_run");
    const run = meldOf([c(5, 3), c(6, 3), c(7, 3)])!;
    assert.strictEqual(openingError([run, jokerRun], 40, 40, DEFAULT_RULES), "below_threshold"); // 18: the joker run doesn't count
    assert.strictEqual(openingError([run, jokerRun], 40, 40, { ...DEFAULT_RULES, jokerPoints: true }), ""); // 18 + 30
  });

  it("a raised bar: 91 clean is still enough, the joker melds make up the rest to 106", () => {
    const clean = [
      meldOf([9, 10, 11, 12, 13].map((r) => c(r, 0)))!, // 49
      meldOf([9, 10, 11, 12].map((r) => c(r, 1)))!, // 39
      meldOf([c(1, 2), c(2, 2), c(3, 2)])!, // 6 → 94 without jokers
    ];
    const jokerMeld = meldOf([c(10, 3), J, c(12, 3)])!; // 30 with the joker
    assert.strictEqual(openingError(clean, 91, 106, DEFAULT_RULES), "below_bar"); // 94 < 106 in all
    assert.strictEqual(openingError([...clean, jokerMeld], 91, 106, DEFAULT_RULES), ""); // 91+ clean, 124 in all
    assert.strictEqual(openingError([clean[0], clean[1], jokerMeld], 91, 106, DEFAULT_RULES), "below_threshold"); // 88 clean
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
    const after = await next(b, (v) => v.discardCount > 0);
    assert.strictEqual(after.turn, sb.me);
    assert.strictEqual(after.stage, "draw");
    assert.deepStrictEqual(after.discardTail, [sa.hand[0]]);

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

  it("putting the taken card back keeps the other melds being put together", async () => {
    const { room, b, send } = await rigged([c(5, 0), c(6, 0), c(7, 0), c(9, 1), c(9, 2), c(9, 3), c(2, 2)], c(8, 0), false);
    await send("take");
    await send("stage", { cards: [c(5, 0), c(6, 0), c(7, 0), c(8, 0)] }); // with the taken 8
    await send("stage", { cards: [c(9, 1), c(9, 2), c(9, 3)] });
    await send("untake");
    assert.deepStrictEqual(room.staged.get(b.sessionId), [[c(9, 1), c(9, 2), c(9, 3)]]); // only the 8's meld came apart
    assert.strictEqual(room.stage, "draw");
  });

  it("raises the opening: after a 119 opening the next one needs 120", async () => {
    const hand = [
      c(9, 0), c(10, 0), c(11, 0), c(12, 0), c(13, 0),
      c(9, 1), c(10, 1), c(11, 1), c(12, 1), c(13, 1),
      c(7, 0), c(7, 1), c(7, 2), c(2, 3),
    ];
    const { room, send } = await rigged(hand, c(4, 2), false);
    await send("draw");
    for (const m of [hand.slice(0, 5), hand.slice(5, 10), hand.slice(10, 13)]) await send("stage", { cards: m });
    await send("lay");
    assert.strictEqual(room.lastOpening, 119);
    assert.strictEqual(room.threshold(), 120);
  });

  it("can't take the discard with one card left; an empty deck reshuffles the discards when drawn", async () => {
    const { room, b, errors, send } = await rigged([c(2, 3)], c(5, 0), true);
    await send("take");
    assert.deepStrictEqual(errors, ["last_card_take"]);
    room.deck = [c(9, 1)];
    room.discard = [c(5, 0), c(6, 0), c(7, 0)];
    await send("draw"); // the deck's last card: the discards stay (the next player may take the top one)
    assert.strictEqual(room.deck.length, 0);
    assert.strictEqual(room.discard.length, 3);
    assert.ok(room.hands.get(b.sessionId).includes(c(9, 1)));
    room.stage = "draw"; // the next turn: he doesn't take it, he reshuffles
    await send("draw");
    assert.strictEqual(room.deck.length, 2);
    assert.strictEqual(room.discard.length, 0);
  });

  it("a set's joker needs every missing card; a complete set goes under the discard pile", async () => {
    const { room, b, errors, send } = await rigged([c(9, 2), c(9, 3), c(4, 1), c(5, 1)], c(5, 0), true);
    room.melds = [
      { id: 1, owner: "x", kind: "set", cards: [c(9, 0), c(9, 1), J] },
      { id: 2, owner: "x", kind: "set", cards: [c(4, 0), c(4, 2), c(4, 3)] },
    ];
    room.discard = [c(13, 0)];
    room.stage = "play";
    await send("swap", { meldId: 1, cards: [c(9, 2)] });
    assert.deepStrictEqual(errors, ["joker_needs_all"]);
    await send("swap", { meldId: 1, cards: [c(9, 2), c(9, 3)] });
    assert.ok(room.hands.get(b.sessionId).includes(J)); // the joker is his
    await send("add", { meldId: 2, cards: [c(4, 1)] }); // 4 4 4 + 4: complete too
    assert.deepStrictEqual(room.melds, []); // both complete sets left the table…
    assert.strictEqual(room.discard.length, 9); // …under the pile
    assert.strictEqual(room.discard[room.discard.length - 1], c(13, 0)); // the top card didn't change
  });

  it("raises the bar with everything laid: 104 + a joker meld worth 30 → the next needs 135", async () => {
    const hand = [
      c(9, 0), c(10, 0), c(11, 0), c(12, 0), c(13, 0), // 49
      c(9, 1), c(10, 1), c(11, 1), c(12, 1), c(13, 1), // 49
      c(2, 2), c(2, 3), c(2, 0), // 6 → 104 without the joker meld
      c(10, 2), J, c(12, 2), // 10 ♦ joker Q ♦: 30
      c(3, 3), // kept to throw
    ];
    const { room, send } = await rigged(hand, c(4, 2), false);
    room.stage = "play";
    for (const m of [hand.slice(0, 5), hand.slice(5, 10), hand.slice(10, 13), hand.slice(13, 16)]) {
      await send("stage", { cards: m });
    }
    await send("lay");
    assert.strictEqual(room.lastOpening, 134);
    assert.strictEqual(room.threshold(), 135);
  });

  it("lays the last card face down — a joker shown face up doubles, face down it's a plain rummy", async () => {
    const down = await rigged([J], c(5, 0), true);
    down.room.stage = "play";
    down.room.handleDiscard({ sessionId: down.b.sessionId }, J, false);
    assert.strictEqual(down.room.lastRound.joker, false);
    assert.strictEqual(down.room.discardDown, true);
    const up = await rigged([J], c(5, 0), true);
    up.room.stage = "play";
    up.room.handleDiscard({ sessionId: up.b.sessionId }, J, true);
    assert.strictEqual(up.room.lastRound.joker, true);
    assert.strictEqual(Object.values(up.room.lastRound.penalties)[0], 200); // never laid down: 100, doubled
  });

  it("2 vs 2: partners face to face, the partner lays without points, one score per team", async () => {
    const room: any = await colyseus.createRoom("rummy", { teams: true });
    const host = await colyseus.connectTo(room);
    host.onMessage("rummy", () => {});
    host.onMessage("rummy_fx", () => {});
    for (let i = 0; i < 3; i++) host.send("add_bot", { level: "normal" });
    await new Promise((r) => setTimeout(r, 150));
    const partner = room.seats[1].id;
    host.send("partner", { id: partner });
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(room.maxPlayers, 4);
    assert.strictEqual(room.seats[2].id, partner); // face to face with the host
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    room.timer?.clear();
    room.botTimer?.clear();
    // The host opened; his partner lays a small meld without points.
    room.opened.add(host.sessionId);
    room.turn = partner;
    room.stage = "play";
    room.hands.set(partner, [c(2, 1), c(3, 1), c(4, 1), c(8, 3)]);
    assert.strictEqual(room.handleStage({ sessionId: partner }, [c(2, 1), c(3, 1), c(4, 1)]), undefined);
    assert.strictEqual(room.handleLay({ sessionId: partner }), undefined);
    assert.ok(room.opened.has(partner));
    // He goes out: the other team takes 100 each (never laid down), one team score.
    room.handleDiscard({ sessionId: partner }, c(8, 3));
    assert.strictEqual(room.phase, "round_end");
    assert.deepStrictEqual(room.teamScores, [0, 200]);
    assert.strictEqual(room.seats[1].score, 200);
    assert.strictEqual(room.seats[3].score, 200);
    // Bots are ready; the host presses ready: the next round comes 5 seconds later.
    assert.strictEqual(room.nextRoundAt, 0);
    room.handleReady(host.sessionId);
    assert.ok(room.nextRoundAt > Date.now());
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
    assert.strictEqual(Object.values(room.lastRound.penalties)[0], 200); // never opened: 100, doubled
  });

  it("plays whole rounds with bots only, every move legal", async () => {
    RummyRoom.botSpeed = 0.01;
    after(() => (RummyRoom.botSpeed = 1));
    const room: any = await colyseus.createRoom("rummy", { losingScore: 500 });
    const host = await colyseus.connectTo(room);
    host.onMessage("rummy", () => {});
    host.onMessage("rummy_fx", () => {});
    for (const level of ["easy", "normal", "hard"]) host.send("add_bot", { level });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(room.seats.length, 4);
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    room.becomeBot(host.sessionId); // the host's seat plays itself too
    const deadline = Date.now() + 50_000;
    while (room.round < 2 && room.phase !== "gameover" && Date.now() < deadline) {
      // Every card is somewhere: deck, discard, hands or the table.
      const all = [...room.deck, ...room.discard, ...[...room.hands.values()].flat(), ...room.melds.flatMap((m: any) => m.cards)];
      assert.strictEqual(new Set(all).size, 108);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(room.lastRound, "a round ended");
    assert.strictEqual(room.botFailures, 0);
  });

  it("2 vs 2: bots play a whole round with partners, every move legal", async () => {
    RummyRoom.botSpeed = 0.01;
    after(() => (RummyRoom.botSpeed = 1));
    const room: any = await colyseus.createRoom("rummy", { losingScore: 500, teams: true });
    const host = await colyseus.connectTo(room);
    host.onMessage("rummy", () => {});
    host.onMessage("rummy_fx", () => {});
    for (const level of ["easy", "normal", "hard"]) host.send("add_bot", { level });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(room.seats.length, 4);
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    room.becomeBot(host.sessionId); // the host's seat plays itself too
    const deadline = Date.now() + 50_000;
    while (room.round < 2 && !room.lastRound && room.phase !== "gameover" && Date.now() < deadline) {
      // Every card is somewhere: deck, discard, hands or the table.
      const all = [...room.deck, ...room.discard, ...[...room.hands.values()].flat(), ...room.melds.flatMap((m: any) => m.cards)];
      assert.strictEqual(new Set(all).size, 108);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(room.lastRound, "a round ended");
    assert.strictEqual(room.botFailures, 0);
  });
});

describe("rummy bot", () => {
  const view = (hand: number[], extra: Partial<BotView> = {}): BotView => ({
    level: "normal", me: "bot", partner: null, partnerOpened: false, rules: DEFAULT_RULES, hand, opened: false,
    threshold: 101, base: 101, melds: [], taken: null,
    canWait: false, nextOpened: false, ...extra,
  });
  const strong = [
    c(9, 0), c(10, 0), c(11, 0), c(12, 0), c(13, 0), // 49
    c(9, 1), c(10, 1), c(11, 1), c(12, 1), c(13, 1), // 49
    c(7, 0), c(7, 1), c(7, 2), // 21
  ];

  it("opens when its melds reach the threshold without jokers, and keeps a card to throw", () => {
    const plan = planTurn(view([...strong, c(2, 3), c(4, 2)]))!;
    assert.strictEqual(plan.lay.flat().length, 13);
    assert.ok([c(2, 3), c(4, 2)].includes(plan.discard));
    assert.strictEqual(plan.finish, false);
    assert.strictEqual(planTurn(view([...strong.slice(5), c(2, 3), c(4, 2)]))!.lay.length, 0); // 70: not enough
  });

  it("goes out with a joker as its last card when it can", () => {
    const plan = planTurn(view([...strong, c(7, 3), J]))!;
    assert.strictEqual(plan.finish, true);
    assert.ok(isJoker(plan.discard));
  });

  it("takes the discard only when it can lay it down this turn", () => {
    assert.ok(wantsDiscard(view([...strong.slice(0, 12), c(2, 3), c(4, 2)]), c(7, 2))); // completes the 7s: 119
    assert.ok(!wantsDiscard(view([...strong.slice(0, 12), c(2, 3), c(4, 2)]), c(3, 3)));
  });

  it("a hard bot holds a card back for a joker finish when it's safe", () => {
    const melds = [{ id: 1, owner: "x", kind: "run" as const, cards: [c(3, 2), c(4, 2), c(5, 2)] }];
    const hand = [c(6, 2), c(9, 3), c(10, 3), c(11, 3), c(2, 1)];
    const hold = planTurn(view(hand, { level: "hard", opened: true, melds, canWait: true }))!;
    assert.ok(hold.waiting && !hold.finish && hold.adds.length === 0);
    const go = planTurn(view(hand, { level: "normal", opened: true, melds }))!;
    assert.ok(go.finish);
  });
});
