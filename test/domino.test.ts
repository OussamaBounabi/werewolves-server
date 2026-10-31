import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { botMove, ends, misdeal, opener, place, shuffledTiles, sidesFor, TILES, type Line } from "../src/domino.js";
import { DominoRoom } from "../src/rooms/DominoRoom.js";
import { moderate, roomPeople } from "../src/rooms/moderate.js";

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

  it("a hand with six tiles of one number, or five doubles, is dealt again", () => {
    const sixes = [T(6, 0), T(6, 1), T(6, 2), T(6, 3), T(6, 4), T(6, 5), T(1, 2)];
    assert.deepStrictEqual(misdeal(new Map([["a", [T(0, 0), T(1, 3), T(2, 4), T(3, 5), T(1, 4), T(2, 5), T(0, 1)]], ["b", sixes]])), {
      id: "b", reason: "number", number: 6, tiles: sixes,
    });
    const doubles = [T(0, 0), T(1, 1), T(2, 2), T(3, 3), T(4, 4), T(0, 1), T(2, 3)];
    assert.strictEqual(misdeal(new Map([["a", doubles]]))?.reason, "doubles");
    assert.strictEqual(misdeal(new Map([["a", [T(6, 0), T(6, 1), T(6, 2), T(6, 3), T(6, 4), T(0, 0), T(1, 1)]]])), null, "five of a number, two doubles: kept");
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

  it("a hand of six 6s: everyone told why, the same round dealt again, the highest double starts", async function () {
    this.timeout(30_000);
    const room: any = await colyseus.createRoom("domino", {});
    const host = await colyseus.connectTo(room);
    let seen: any = null;
    host.onMessage("domino", (m) => (seen = m));
    host.onMessage("domino_fx", () => {});
    host.send("add_bot", { level: "normal" });
    await new Promise((r) => setTimeout(r, 200));
    // the deal pops from the end, one tile each in turn: the host (first seat) gets 27, 25 … 15
    const sixes = [T(0, 6), T(1, 6), T(2, 6), T(3, 6), T(4, 6), T(5, 6), T(6, 6)];
    const rest = TILES.map((_, i) => i).filter((i) => !sixes.includes(i));
    const deck = Array.from({ length: 28 }, (_, i) => (i >= 15 && (i - 15) % 2 === 0 ? sixes[(i - 15) / 2] : rest.shift()!));
    DominoRoom.shuffle = () => {
      DominoRoom.shuffle = shuffledTiles; // (only the first deal)
      return [...deck];
    };
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual([seen.redeal?.id, seen.redeal?.reason, seen.redeal?.number, seen.turn], [host.sessionId, "number", 6, ""]);
    room.becomeBot(host.sessionId); // (his opening tile played for him)
    while (room.redeal) await new Promise((r) => setTimeout(r, 5));
    const open = opener(room.hands)!; // (the new hands: the highest double in them, 6-6 if dealt)
    assert.ok(TILES[open.tile][0] === TILES[open.tile][1]);
    while (room.line.first === null) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(room.line.first, open.tile, "the highest double starts");
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(seen.redeal, null);
    assert.strictEqual(seen.round, 1, "the same round");
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

  it("2 vs 2: a team at half the target has its round winner choose who opens, he or his partner", async () => {
    const room: any = await colyseus.createRoom("domino", { teams: true, target: 100 });
    const host = await colyseus.connectTo(room);
    let seen: any = null;
    host.onMessage("domino", (m) => (seen = m));
    host.onMessage("domino_fx", () => {});
    for (let i = 0; i < 3; i++) host.send("add_bot", { level: "easy" });
    await new Promise((r) => setTimeout(r, 200));
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    const ids = room.seats.map((s: any) => s.id); // the host and ids[2] against ids[1] and ids[3]
    // Below half (49 of 100): the winner opens, as always.
    room.lastWinner = host.sessionId;
    room.teamScores = [49, 0];
    room.deal();
    assert.deepStrictEqual([room.choosing, room.turn], ["", host.sessionId]);
    // Half (50): he chooses, nobody plays meanwhile; he hands the opening to his partner.
    room.lastWinner = host.sessionId;
    room.teamScores = [50, 0];
    room.deal();
    room.sync();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual([room.choosing, room.turn, seen.choosing], [host.sessionId, "", host.sessionId]);
    host.send("opener", { partner: true });
    while (room.choosing) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(room.turn, ids[2]);
    assert.strictEqual(room.forced, null); // any tile, as a winner opens
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

  it("a chat room: so in the list and the table, no voice; a room without it has voice", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const chat: any = await colyseus.createRoom("domino", { chat: true });
    const voice: any = await colyseus.createRoom("domino", {});
    assert.deepStrictEqual([chat.metadata.chat, voice.metadata.chat], [true, false]);
    assert.deepStrictEqual([chat.voiceOn, chat.chatOnly], [false, true]);
    const host = await colyseus.connectTo(chat);
    let seen: any = null, told: any = null;
    host.onMessage("domino", (s: any) => (seen = s));
    host.onMessage("voice", (v: any) => (told = v));
    host.send("voice_join");
    while (!seen || !told) await sleep(20);
    assert.deepStrictEqual([seen.chat, told.enabled], [true, false]);
    chat.disconnect();
    voice.disconnect();
  });

  it("support in a room: who is there, a mute, a line from support, someone put out and kept out, the room closed", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const room: any = await colyseus.createRoom("domino", {});
    const host = await colyseus.connectTo(room, { playerId: "p-host" });
    const guest = await colyseus.connectTo(room, { playerId: "p-guest" });
    const lines: any[] = [], notices: any[] = [], errors: any[] = [];
    for (const [who, c] of [["host", host], ["guest", guest]] as const) {
      c.onMessage("domino", () => {});
      c.onMessage("domino_fx", () => {});
      c.onMessage("chat_history", () => {});
      c.onMessage("chat", (l: any) => lines.push({ to: who, ...l }));
      c.onMessage("admin_notice", (n: any) => notices.push({ to: who, ...n }));
      c.onMessage("error", (e: any) => errors.push({ to: who, ...e }));
    }
    await sleep(100);
    // (no accounts in tests: the two are given theirs)
    for (const [i, c] of room.clients.entries()) {
      const uid = i === 0 ? "u-host" : "u-guest";
      c.auth = { account: { uid, name: i === 0 ? "Host" : "Guest", avatar: 0, frame: 0 } };
      room.members.set(c.sessionId, uid);
    }
    assert.deepStrictEqual(roomPeople(room.roomId).people.map((p: any) => [p.uid, p.seated, p.muted]), [["u-host", true, false], ["u-guest", true, false]]);

    await moderate(room.roomId, "mute", "u-guest");
    guest.send("chat", { text: "hello?" });
    await sleep(100);
    assert.deepStrictEqual([notices.at(-1), errors.at(-1)?.code, lines.length], [{ to: "guest", kind: "muted" }, "admin_muted", 0]);
    assert.strictEqual(roomPeople(room.roomId).people[1].muted, true);

    await moderate(room.roomId, "say", "", "Play nice");
    await sleep(100);
    assert.deepStrictEqual(lines.map((l) => [l.to, l.from, l.text]).sort(), [["guest", "admin", "Play nice"], ["host", "admin", "Play nice"]]);

    await moderate(room.roomId, "unmute", "u-guest");
    guest.send("chat", { text: "sorry" });
    await sleep(100);
    assert.strictEqual(lines.at(-1).text, "sorry");

    await moderate(room.roomId, "kick", "u-guest");
    await sleep(150);
    assert.ok(notices.some((n) => n.to === "guest" && n.kind === "kicked"));
    assert.ok(room.banned.has("u-guest"), "kept out while the room lasts");
    assert.strictEqual(room.seats.length, 1);

    await moderate(room.roomId, "close");
    await sleep(500);
    assert.ok(notices.some((n) => n.to === "host" && n.kind === "closed"));
    assert.strictEqual(room.clients.length, 0);
    await assert.rejects(moderate(room.roomId, "say", "", "anyone?"), /gone/);
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

  it("after a match: all press play again, a new match from 0; one left, or the minute is up, the waiting room", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const room: any = await colyseus.createRoom("domino", {});
    const join = async () => {
      const c: any = await colyseus.connectTo(room);
      c.onMessage("domino", () => {});
      c.onMessage("domino_fx", () => {});
      return c;
    };
    const host = await join(), guest = await join();
    host.send("add_bot", { level: "easy" });
    await sleep(100);
    room.target = 1; // the first round wins the match
    const play = async () => {
      host.send("start_game");
      while (room.phase !== "playing") await sleep(20);
      room.endRound(host.sessionId, false);
      assert.strictEqual(room.phase, "gameover");
    };
    await play();
    // Both press: the same table, a new match from 0.
    host.send("play_again");
    guest.send("play_again");
    while (room.phase !== "playing") await sleep(20);
    assert.deepStrictEqual([room.round, room.history.length, room.seats.map((s: any) => s.score)], [1, 0, [0, 0, 0]]);

    // The host presses, the guest leaves: back to the waiting room, his seat free, the host's bot still there.
    room.endRound(host.sessionId, false);
    host.send("play_again");
    await guest.leave();
    while (room.phase !== "lobby") await sleep(20);
    assert.deepStrictEqual(room.seats.map((s: any) => s.id), [host.sessionId, room.seats[1].id]);
    assert.ok(room.seats[1].id.startsWith("bot-"));
    assert.deepStrictEqual([room.metadata.started, room.seats[0].score], [false, 0]);

    // A newcomer who doesn't press: when the minute is up, he goes home and the others to the waiting room.
    const late = await join();
    let gone = false;
    late.onLeave(() => (gone = true));
    while (room.seats.length < 3) await sleep(20);
    await play();
    host.send("play_again");
    await sleep(100);
    room.afterGame(true);
    assert.deepStrictEqual([room.phase, room.seats.length], ["lobby", 2]);
    while (!gone) await sleep(20);

    // One presses, then leaves before the host does: his seat doesn't go back to the waiting room (as a bot).
    const third = await join();
    while (room.seats.length < 3) await sleep(20);
    await play();
    third.send("play_again");
    await sleep(100);
    await third.leave();
    while (!room.seat(third.sessionId)?.bot) await sleep(20);
    host.send("play_again");
    while (room.phase !== "lobby") await sleep(20);
    assert.deepStrictEqual(room.seats.map((s: any) => s.id), [host.sessionId, room.seats[1].id]);
    assert.ok(room.seats[1].id.startsWith("bot-"));

    // Nobody presses: the room closes.
    await play();
    room.afterGame(true);
    assert.ok(room.abandon.closing);
  });
});
