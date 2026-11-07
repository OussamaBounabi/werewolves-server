import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { botMove, canPlay, newDeck, points } from "../src/uno.js";
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
    assert.ok(!canPlay("w-draw4", "r-draw2", "r", 2), "nor a +4 on a +2");
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
    it(`bots play whole matches${stacking ? " with stacking" : ""} round after round, every card accounted for`, async function () {
      this.timeout(400_000);
      const { room, host } = await started(5, { stacking, maxPlayers: 6, target: 500 });
      room.becomeBot(host.sessionId);
      room.abandon.check = () => {}; // (only bots at the table: it would close after a minute, before a long match ends)
      let rounds = 0;
      while (room.phase !== "gameover") {
        if (room.phase === "playing") assert.strictEqual(total(room), 108);
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
