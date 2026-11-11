import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { ALL_WILDS, botChallenges, botMove, canPlay, newDeck, points } from "../src/uno.js";
import { UnoRoom } from "../src/rooms/UnoRoom.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("uno cards", () => {
  it("108 cards: per color one 0 and two of everything else; four of each wild", () => {
    const deck = newDeck();
    assert.strictEqual(deck.length, 108);
    const count = (c: string) => deck.filter((x) => x === c).length;
    assert.deepStrictEqual([count("r-0"), count("g-7"), count("b-skip"), count("y-draw2"), count("w-wild"), count("w-draw4")], [1, 2, 2, 2, 4, 4]);
    assert.deepStrictEqual([points("r-7"), points("g-rev"), points("w-draw4")], [7, 20, 50]);
  });

  it("a card goes by color, by kind, or wild; on a waiting +2 only a +2", () => {
    assert.ok(canPlay("r-3", "r-9", "r"));
    assert.ok(canPlay("b-9", "r-9", "r"));
    assert.ok(canPlay("g-skip", "r-skip", "r"));
    assert.ok(!canPlay("g-3", "r-9", "r"));
    assert.ok(canPlay("w-wild", "r-9", "r"));
    assert.ok(canPlay("g-3", "w-wild", "g"), "a wild's named color");
    assert.ok(canPlay("b-draw2", "r-draw2", "r", 2));
    assert.ok(!canPlay("r-5", "r-draw2", "r", 2), "a +2 waiting: not a plain card");
    assert.ok(canPlay("w-draw4", "r-draw2", "r", 2), "a +4 on a +2");
    assert.ok(!canPlay("r-draw2", "w-draw4", "r", 4), "never a +2 on a +4");
  });

  it("All Wilds: 132 cards, four of each new wild; a plain wild counts 20; a wild on top goes by its color only", () => {
    const deck = newDeck(true);
    assert.strictEqual(deck.length, 132);
    for (const k of ALL_WILDS) assert.strictEqual(deck.filter((c) => c === `w-${k}`).length, 4, k);
    assert.deepStrictEqual([points("w-wild", true), points("w-swap", true), points("w-draw4", true), points("r-rev", true)], [20, 50, 50, 20]);
    assert.ok(!canPlay("r-skip", "w-skip", "g"), "a skip on a wild skip: its color only");
    assert.ok(canPlay("g-skip", "w-skip", "g"));
    assert.ok(canPlay("w-draw2", "r-draw2", "r", 2), "a wild +2 stacks on a +2");
    assert.ok(canPlay("b-draw2", "w-draw2", "y", 2));
    // A swap only when another holds fewer cards than it would.
    const swap = (fewestOther: number) => botMove({ level: "normal", hand: ["w-swap", "g-3", "g-4", "g-5"], top: "r-1", color: "r", pending: 0, nextCards: 5, fewestOther });
    assert.deepStrictEqual([swap(2)?.card, swap(3)], ["w-swap", null]);
  });

  it("bots: normal keeps its wild for last; hard hits a player about to win", () => {
    const hand = ["w-wild", "r-4", "r-skip"];
    assert.strictEqual(botMove({ level: "normal", hand, top: "r-9", color: "r", pending: 0, nextCards: 5 })?.card, "r-skip");
    assert.strictEqual(botMove({ level: "normal", hand: ["w-wild", "r-4"], top: "r-9", color: "r", pending: 0, nextCards: 5 })?.card, "r-4");
    const hard = botMove({ level: "hard", hand: ["r-9", "w-draw4", "b-2", "b-5"], top: "r-1", color: "r", pending: 0, nextCards: 1 });
    assert.deepStrictEqual(hard, { card: "w-draw4", color: "b" });
    assert.strictEqual(botMove({ level: "hard", hand: ["g-3"], top: "r-1", color: "r", pending: 0, nextCards: 1 }), null);
  });
});

describe("UnoRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    UnoRoom.botSpeed = 0.01;
    UnoRoom.pace = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    UnoRoom.botSpeed = 1;
    UnoRoom.pace = 1;
    await colyseus.shutdown();
  });

  /** A room with the host and [bots] bots, started; the host's seat then played by a bot if [botHost]. */
  async function started(bots: number, options: Record<string, unknown> = {}) {
    const room: any = await colyseus.createRoom("uno", options);
    const host = await colyseus.connectTo(room);
    host.onMessage("uno", () => {});
    host.onMessage("uno_fx", () => {});
    host.onMessage("uno_drawn", () => {});
    for (let i = 0; i < bots; i++) host.send("add_bot", { level: ["easy", "normal", "hard"][i % 3] });
    await wait(150);
    host.send("start_game");
    while (room.phase !== "playing") await wait(10);
    return { room, host };
  }

  const total = (room: any) => [...room.hands.values()].reduce((n: number, h: string[]) => n + h.length, 0) + room.pile.length + room.discard.length;

  for (const stacking of [false, true]) {
    // (With stacking, in All Wilds: its 132 cards, swaps and all.)
    it(`bots play whole matches${stacking ? " with stacking, All Wilds" : ""} round after round, every card accounted for`, async function () {
      this.timeout(400_000);
      const { room, host } = await started(5, { stacking, allWilds: stacking, maxPlayers: 6, target: 500 });
      room.becomeBot(host.sessionId);
      room.abandon.check = () => {}; // (only bots at the table: it would close after a minute, before a long match ends)
      let rounds = 0;
      while (room.phase !== "gameover") {
        if (room.phase === "playing") assert.strictEqual(total(room), stacking ? 132 : 108);
        rounds = Math.max(rounds, room.round);
        await wait(20);
      }
      assert.strictEqual(room.hands.get(room.winner).length, 0);
      assert.ok(room.seats.some((s: any) => s.score >= 500), "someone reached the target");
      assert.strictEqual(room.history.length, rounds);
      assert.strictEqual(room.history.reduce((n: number, r: any) => n + r.points, 0), room.seats.reduce((n: number, s: any) => n + s.score, 0));
      await host.leave();
    });
  }

  /** The host's turn, with this hand and this top card. */
  function rig(room: any, id: string, hand: string[], top: string, color = top[0]) {
    room.botTimer?.clear();
    room.hands.set(id, [...hand]);
    room.discard.push(top);
    room.color = color;
    room.pending = 0;
    room.d4 = null;
    room.direction = 1; // (the bots may have played a reverse meanwhile)
    room.unoOpen = "";
    room.startTurn(id);
  }

  it("a +2 without stacking: the next player draws two and loses his turn; with 2 players a reverse skips", async () => {
    const { room, host } = await started(2);
    const [me, a, b] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["r-draw2", "r-5", "g-1"], "r-9");
    const before = room.hands.get(a).length;
    room.handlePlay(me, "r-draw2");
    assert.strictEqual(room.hands.get(a).length, before + 2);
    assert.strictEqual(room.turn, b, "the one after him plays");
    room.botTimer?.clear();
    room.handlePlay(b, "x"); // (not his card: nothing)
    rig(room, me, ["r-skip", "r-5", "g-1"], "r-9");
    room.handlePlay(me, "r-skip");
    assert.strictEqual(room.turn, b, "a skip");
    await host.leave();
  });

  it("stacking: +2 on +2, the third player takes four", async () => {
    const { room, host } = await started(2, { stacking: true });
    const [me, a, b] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["r-draw2", "r-5", "g-1"], "r-9");
    room.handlePlay(me, "r-draw2");
    assert.deepStrictEqual([room.turn, room.pending], [a, 2]);
    room.botTimer?.clear();
    room.hands.get(a).push("b-draw2", "r-5");
    assert.strictEqual(room.handlePlay(a, "r-5"), "no_match", "only a +2 on a waiting +2");
    room.handlePlay(a, "b-draw2");
    assert.deepStrictEqual([room.turn, room.pending], [b, 4]);
    room.botTimer?.clear();
    const before = room.hands.get(b).length;
    room.handleDraw(b);
    assert.deepStrictEqual([room.hands.get(b).length, room.pending, room.turn], [before + 4, 0, me]);
    await host.leave();
  });

  it("out with a +4: the next player draws four, they count, the round is over", async () => {
    const { room, host } = await started(2, { target: 500 });
    const [me, a] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["w-draw4"], "r-9");
    room.hands.set(a, ["r-1"]);
    room.handlePlay(me, "w-draw4", "g");
    assert.strictEqual(room.phase, "round_end");
    assert.strictEqual(room.hands.get(a).length, 5);
    const last = room.history[room.history.length - 1];
    assert.strictEqual(last.winner, me);
    assert.strictEqual(last.left[a], room.hands.get(a).reduce((n: number, c: string) => n + points(c), 0));
    assert.ok(last.left[a] >= 1, "the four drawn count");
    await host.leave();
  });

  it("a +4: drawn, or challenged; a bluff caught, the bluffer draws 4 and I play; honest, I draw 6", async () => {
    const { room, host } = await started(2);
    const [me, a, b] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    const play4 = (hand: string[], direction = 1) => {
      rig(room, a, ["w-draw4", ...hand], "r-9");
      room.direction = direction;
      room.handlePlay(a, "w-draw4", "g");
      room.botTimer?.clear();
    };
    const mine = () => room.hands.get(me).length;
    // Drawn: four, my turn over.
    play4(["b-1", "y-2"]);
    assert.deepStrictEqual([room.turn, room.pending, room.d4.who], [b, 4, a], "it waits for the next player");
    room.hands.set(b, ["g-1", "g-2"]);
    assert.strictEqual(room.handlePlay(b, "g-1"), "no_match", "no stacking: challenge or draw");
    room.handleDraw(b);
    assert.deepStrictEqual([room.hands.get(b).length, room.turn, room.d4], [6, me, null]);
    // A bluff (he held a red, the color asked): he draws 4, I play, the named color stays.
    room.hands.set(me, ["r-1", "b-4"]);
    play4(["r-3", "b-1"], -1); // (a plays before me)
    assert.strictEqual(room.turn, me);
    const before = mine();
    room.handleChallenge(me);
    assert.deepStrictEqual([room.hands.get(a).length, mine(), room.turn, room.color, room.pending], [6, before, me, "g", 0]);
    // Honest (a blue and a +2 of another color don't count): I draw 6, my turn over.
    play4(["b-1", "y-draw2"], -1);
    room.handleChallenge(me);
    assert.deepStrictEqual([mine(), room.turn, room.hands.get(a).length], [before + 6, b, 2]);
    room.handleChallenge(me); // (not my turn, no +4: nothing)
    assert.strictEqual(mine(), before + 6);
    await host.leave();
  });

  it("a +4 with stacking: a lone one may be challenged; on a stack it can't; who can't stack draws it at once", async () => {
    const { room, host } = await started(2, { stacking: true });
    const [me, a, b] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["w-draw4", "r-draw2", "b-1", "b-2"], "r-9");
    room.handlePlay(me, "w-draw4", "y");
    room.botTimer?.clear();
    assert.strictEqual(room.d4.who, me); // (a lone +4)
    room.hands.set(a, ["w-draw4", "y-5", "g-1"]);
    room.hands.set(b, ["r-draw2", "g-2"]); // (a +2: never on a +4)
    room.handlePlay(a, "w-draw4", "g");
    assert.deepStrictEqual([room.turn, room.pending, room.d4], [b, 8, null]);
    room.handleChallenge(b); // (no challenge on a stack)
    assert.strictEqual(room.handlePlay(b, "r-draw2"), "no_match");
    assert.deepStrictEqual([room.turn, room.pending], [b, 8]);
    await wait(1_700); // (nothing to stack: he draws it, his turn shown a moment)
    assert.deepStrictEqual([room.hands.get(b).length, room.pending, room.turn], [10, 0, me]);

    // A +4 on a +2: the next player stacks a +4 or draws.
    room.botTimer?.clear();
    rig(room, me, ["r-draw2", "b-1", "b-2"], "r-9");
    room.handlePlay(me, "r-draw2");
    room.botTimer?.clear();
    room.hands.set(a, ["w-draw4", "y-5"]);
    room.hands.set(b, ["w-draw4", "g-2"]);
    room.handlePlay(a, "w-draw4", "g");
    room.botTimer?.clear();
    assert.deepStrictEqual([room.turn, room.pending, room.d4], [b, 6, null]);
    await wait(1_700); // (he holds a +4: no drawing for him, it's his call)
    assert.deepStrictEqual([room.turn, room.pending], [b, 6]);
    room.handlePlay(b, "w-draw4", "r");
    assert.deepStrictEqual([room.turn, room.pending], [me, 10]);
    await host.leave();
  });

  it("bots challenge a +4 more often the more cards its player holds; easy never", () => {
    assert.ok(!botChallenges("easy", 20, () => 0));
    assert.ok(!botChallenges("hard", 2, () => 0), "two cards: he likely had no other");
    assert.ok(botChallenges("hard", 8, () => 0.4));
    assert.ok(!botChallenges("normal", 8, () => 0.6), "one time in two at most");
  });

  it("the round's clock: out of time, the lowest hand wins and scores the others'; even, fewer cards, then turn order", async () => {
    UnoRoom.roundScale = 0.001; // (5 minutes: 300 ms)
    try {
      const { room, host } = await started(2, { roundMinutes: 5 });
      const [me, a, b] = room.seats.map((s: any) => s.id);
      rig(room, me, ["r-9", "b-9"], "r-5"); // (my turn: no bot plays meanwhile)
      room.hands.set(a, ["r-1", "g-2", "y-3"]);
      room.hands.set(b, ["w-wild"]);
      while (room.phase === "playing") await wait(10);
      const last = room.history[room.history.length - 1];
      assert.deepStrictEqual([last.winner, last.points, last.timeUp], [a, 18 + 50, true]);
      assert.strictEqual(room.seat(a).score, 68);
      await host.leave();

      const two = await started(2, { roundMinutes: 3 });
      const [me2, a2, b2] = two.room.seats.map((s: any) => s.id);
      rig(two.room, me2, ["r-5"], "r-1");
      two.room.hands.set(a2, ["r-2", "g-3"]); // (5 points too, but two cards)
      two.room.hands.set(b2, ["b-5"]); // (even with me: I play first)
      while (two.room.phase === "playing") await wait(10);
      assert.strictEqual(two.room.winner, me2);
      await two.host.leave();
    } finally {
      UnoRoom.roundScale = 1;
    }
  });

  it("All Wilds: skip two, a targeted +2 (the turn goes on), a hand swap; a player to name, or none to pick", async () => {
    const { room, host } = await started(3, { allWilds: true });
    assert.strictEqual(room.allWilds, true);
    const [me, a, b, c] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    const fx: any[] = [];
    host.onMessage("uno_fx", (m: any) => fx.push(m));
    // Skip two: a and b lose their turn.
    rig(room, me, ["w-skip2", "r-5", "g-1"], "r-9");
    host.send("play", { card: "w-skip2", color: "g" });
    while (room.turn === me) await wait(5);
    assert.deepStrictEqual([room.turn, room.color], [c, "g"]);
    // A targeted +2 names b: he draws 2 at once; it's a's turn.
    rig(room, me, ["w-target2", "r-5", "g-1"], "r-9");
    const before = room.hands.get(b).length;
    host.send("play", { card: "w-target2", color: "b" });
    await wait(80);
    assert.strictEqual(room.turn, me, "no player named: refused");
    host.send("play", { card: "w-target2", color: "b", target: b });
    while (room.turn === me) await wait(5);
    assert.deepStrictEqual([room.turn, room.hands.get(b).length], [a, before + 2]);
    // A hand swap with c: my two other cards are his, his mine.
    rig(room, me, ["w-swap", "r-5", "g-1"], "r-9");
    room.hands.set(c, ["y-1", "y-2", "y-3", "y-4"]);
    host.send("play", { card: "w-swap", color: "y", target: c });
    while (room.turn === me) await wait(5);
    assert.deepStrictEqual([room.hands.get(me), room.hands.get(c)], [["y-1", "y-2", "y-3", "y-4"], ["r-5", "g-1"]]);
    assert.ok(fx.some((m) => m.type === "swap" && m.who === me && m.with === c));
    // The last card a swap: out, nothing swapped.
    rig(room, me, ["w-swap"], "r-9");
    host.send("play", { card: "w-swap", color: "r", target: c });
    while (room.phase === "playing") await wait(5);
    assert.strictEqual(room.history.at(-1).winner, me);
    await host.leave();
  });

  it("All Wilds with 2 players: skip two and a swap need no name; a bot swaps with the one holding fewer", async () => {
    const { room, host } = await started(1, { allWilds: true });
    const [me, a] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["w-skip2", "r-5", "g-1"], "r-9");
    host.send("play", { card: "w-skip2", color: "r" });
    await wait(80);
    assert.strictEqual(room.turn, me, "skip two with one other: my turn again");
    room.hands.set(a, ["w-swap", "b-1", "b-2", "b-3"]);
    host.send("play", { card: "r-5" }); // (now a's turn: he holds 4, I hold 1 after this… he swaps for my one card)
    while (room.turn === me) await wait(5);
    while (room.turn === a) await wait(10);
    // (my turn's quick test clock may have drawn me a card since)
    assert.deepStrictEqual([room.hands.get(a), room.hands.get(me).slice(0, 3)], [["g-1"], ["b-1", "b-2", "b-3"]]);
    await host.leave();
  });

  it("2 vs 2: partners face to face, each sees his partner's cards, a round won scores the opponents' hands for both", async () => {
    const room: any = await colyseus.createRoom("uno", { teams: true, target: 500 });
    const host = await colyseus.connectTo(room);
    let seen: any = null;
    host.onMessage("uno", (m) => (seen = m));
    host.onMessage("uno_fx", () => {});
    host.onMessage("uno_drawn", () => {});
    for (let i = 0; i < 3; i++) host.send("add_bot", { level: "hard" });
    await wait(150);
    host.send("partner", { id: room.seats[3].id });
    await wait(50);
    host.send("start_game");
    while (room.phase !== "playing") await wait(10);
    await wait(80);
    const [me, a, b, c] = room.seats.map((s: any) => s.id);
    assert.deepStrictEqual(seen.partnerHand, room.hands.get(b), "my partner faces me");
    assert.deepStrictEqual(seen.seats.map((s: any) => s.team), [0, 1, 0, 1]);
    rig(room, me, ["r-3"], "r-9");
    room.hands.set(a, ["r-5"]);
    room.hands.set(b, ["b-9"]);
    room.hands.set(c, ["w-wild"]);
    room.unoOpen = me;
    room.handleCatch(b, me);
    assert.strictEqual(room.unoOpen, me, "my partner can't catch me");
    room.unoOpen = "";
    room.handlePlay(me, "r-3");
    assert.strictEqual(room.history[room.history.length - 1].points, 55, "5 + 50, not my partner's 9");
    assert.deepStrictEqual(room.seats.map((s: any) => s.score), [55, 0, 55, 0]);
    await host.leave();
  });

  it("UNO: forgotten, caught, two cards; pressed in time, safe", async () => {
    const { room, host } = await started(1);
    const [me, bot] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["r-3", "r-5"], "r-9");
    room.handlePlay(me, "r-3");
    assert.strictEqual(room.unoOpen, me);
    room.catchTimer?.clear();
    room.handleCatch(bot, me);
    assert.deepStrictEqual([room.unoOpen, room.hands.get(me).length], ["", 3]);
    rig(room, me, ["r-3", "r-5"], "r-9");
    room.handleUno(me);
    room.handlePlay(me, "r-3");
    assert.strictEqual(room.unoOpen, "");
    room.handleCatch(bot, me);
    assert.strictEqual(room.hands.get(me).length, 1, "nothing to catch");
    // Forgotten, then pressed before anyone caught him: safe too.
    rig(room, me, ["r-3", "r-5"], "r-9");
    room.handlePlay(me, "r-3");
    room.handleUno(me);
    room.handleCatch(bot, me);
    assert.strictEqual(room.hands.get(me).length, 1);
    // No bot to hit the hammer: it stays 2 s, through the others' moves, then goes.
    room.seats[1].bot = "easy";
    rig(room, me, ["r-3", "r-5"], "r-9");
    room.handlePlay(me, "r-3");
    await wait(1500);
    assert.strictEqual(room.unoOpen, me, "still open after the bot moved");
    await wait(700);
    assert.strictEqual(room.unoOpen, "", "closed after 2 s");
    await host.leave();
  });

  it("a drawn card that goes may be played (only it); one that doesn't ends the turn", async () => {
    const { room, host } = await started(1);
    const [me, bot] = room.seats.map((s: any) => s.id);
    while (room.turn === "") await wait(5);
    rig(room, me, ["g-3", "r-5"], "r-9");
    room.pile.push("r-1");
    room.handleDraw(me);
    assert.strictEqual(room.drew, "r-1");
    assert.strictEqual(room.handlePlay(me, "r-5"), "drawn_only");
    room.handlePlay(me, "r-1");
    assert.strictEqual(room.turn, bot);
    rig(room, me, ["g-3", "r-5"], "r-9");
    room.pile.push("b-2");
    room.handleDraw(me);
    await wait(1_300);
    assert.ok(room.hands.get(me).includes("b-2") && room.drew !== "b-2", "kept, and the turn passed by itself");
    await host.leave();
  });
});
