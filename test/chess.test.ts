import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { ChessRoom } from "../src/rooms/ChessRoom.js";
import { chessBotMove, chessEnd, legalMoves, makeMove, posKey, startPos, type ChessPos } from "../src/chess.js";
import { checkersBotMove, checkersEnd, checkersKey, checkersMoves, checkersPlay, checkersStart, type CheckersPos } from "../src/checkers.js";

/** A position from FEN (tests only). */
function fen(text: string): ChessPos {
  const [rows, turn, castle, ep, half] = text.split(" ");
  const board = Array<string>(64).fill("");
  rows.split("/").forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else board[(7 - i) * 8 + f++] = ch;
    }
  });
  const epSq = ep === "-" ? -1 : ep.charCodeAt(0) - 97 + (Number(ep[1]) - 1) * 8;
  return { board, turn: turn === "w" ? 0 : 1, castle: castle === "-" ? "" : castle, ep: epSq, half: Number(half ?? 0) };
}

function perft(pos: ChessPos, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(pos)) n += perft(makeMove(pos, m), depth - 1);
  return n;
}

describe("chess rules", () => {
  it("counts every move like the reference (perft)", function () {
    this.timeout(120_000);
    assert.deepStrictEqual([1, 2, 3].map((d) => perft(startPos(), d)), [20, 400, 8902]);
    // "Kiwipete": castling, en passant, promotions, pins
    const kiwi = fen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0");
    assert.deepStrictEqual([1, 2, 3].map((d) => perft(kiwi, d)), [48, 2039, 97862]);
    const p3 = fen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0");
    assert.deepStrictEqual([1, 2, 3, 4].map((d) => perft(p3, d)), [14, 191, 2812, 43238]);
    const p4 = fen("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0");
    assert.deepStrictEqual([1, 2, 3].map((d) => perft(p4, d)), [6, 264, 9467]);
  });

  it("knows checkmate, stalemate and the draws", () => {
    assert.deepStrictEqual(chessEnd(fen("7k/6Q1/6K1/8/8/8/8/8 b - - 0"), []), { end: "checkmate", winner: 0 });
    assert.deepStrictEqual(chessEnd(fen("7k/8/6QK/8/8/8/8/8 b - - 0"), []), { end: "stalemate", winner: null });
    assert.deepStrictEqual(chessEnd(fen("7k/8/6NK/8/8/8/8/8 b - - 0"), []), { end: "material", winner: null });
    assert.deepStrictEqual(chessEnd(fen("7k/8/8/8/8/8/8/R5K1 b - - 100"), []), { end: "fifty", winner: null });
    const p = startPos();
    assert.deepStrictEqual(chessEnd(p, [posKey(p), posKey(p), posKey(p)]), { end: "repetition", winner: null });
    assert.strictEqual(chessEnd(p, [posKey(p)]), null);
  });

  it("the bot takes a free queen and mates in one", () => {
    const free = fen("4k3/8/8/3q4/8/8/8/3QK3 w - - 0"); // d1 takes d5
    for (const level of ["normal", "hard"] as const) assert.deepStrictEqual(chessBotMove(free, level), { from: 3, to: 35 });
    const mate = fen("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0"); // Ra8#
    assert.deepStrictEqual(chessBotMove(mate, "hard"), { from: 0, to: 56 });
  });

  it("two bots finish a game", function () {
    this.timeout(120_000);
    let pos = startPos();
    const keys = [posKey(pos)];
    let end = null;
    for (let ply = 0; ply < 400 && !end; ply++) {
      pos = makeMove(pos, chessBotMove(pos, ply % 2 ? "easy" : "normal"));
      keys.push(posKey(pos));
      end = chessEnd(pos, keys);
    }
    assert.ok(end, "ended");
  });
});

/** A checkers position from a picture of the board, rank 8 first ("." empty). */
function board(rows: string[], turn: 0 | 1): CheckersPos {
  const b = Array<string>(64).fill("");
  rows.forEach((row, i) => [...row].forEach((ch, f) => (b[(7 - i) * 8 + f] = ch === "." ? "" : ch)));
  return { board: b, turn, quiet: 0 };
}
const at = (name: string) => name.charCodeAt(0) - 97 + (Number(name[1]) - 1) * 8;

describe("checkers rules", () => {
  it("starts with 7 moves for black, who moves first", () => {
    const p = checkersStart();
    assert.strictEqual(p.turn, 1);
    assert.strictEqual(checkersMoves(p).length, 7);
    assert.strictEqual(p.board.filter((x) => x === "w").length, 12);
  });

  it("forces captures, jumps on while it can, and crowns at the far rank", () => {
    const p = board([
      "........",
      "........",
      "........",
      "........",
      "...b....",
      "........",
      ".b......",
      "w.....w.",
    ], 0);
    // a1 jumps b2 to c3, then d4 to e5 (two captures); the plain moves aren't allowed
    const forced = checkersMoves(p);
    assert.deepStrictEqual(forced.map((m) => m.path), [[at("a1"), at("c3"), at("e5")]]);
    assert.ok(checkersMoves(p, false).length > 1); // the room may let captures be optional
    const crown = board([
      "........",
      "..b.....",
      ".w......",
      "........",
      "........",
      "........",
      "........",
      "........",
    ], 1);
    const m = checkersMoves(crown)[0]; // black goes down: c7 takes b6, lands on a5
    assert.deepStrictEqual(m.path, [at("c7"), at("a5")]);
    const up = board(["........", ".w......", "........", "........", "........", "........", "........", "........"], 0);
    const after = checkersPlay(up, checkersMoves(up)[0]);
    assert.ok(after.board.includes("W"), "crowned");
  });

  it("starts on the light squares (each player's near left corner light)", () => {
    const p = checkersStart();
    assert.strictEqual(p.board[at("a1")], "");
    assert.strictEqual(p.board[at("b1")], "w");
    assert.strictEqual(p.board[at("a8")], "b");
  });

  it("kings fly: they move and capture from any distance, and chain captures", () => {
    const fly = board([
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "W.......",
    ], 0);
    assert.strictEqual(checkersMoves(fly).length, 7, "a1 to h8, any distance");
    const far = board([
      "........",
      "........",
      ".....b..",
      "........",
      "...b....",
      "........",
      "........",
      "W.......",
    ], 0);
    // a1 takes d4 from afar, lands on e5, then takes f6, lands on g7 or h8
    const caps = checkersMoves(far).map((m) => [m.path, m.captures.length]);
    assert.deepStrictEqual(caps, [[[at("a1"), at("e5"), at("g7")], 2], [[at("a1"), at("e5"), at("h8")], 2]]);
    // a taken piece blocks: no jumping it twice, no passing through it
    const after = checkersPlay(far, checkersMoves(far)[0]);
    assert.strictEqual(after.board.filter((x) => x === "b").length, 0);
  });

  it("a player with no move loses; two bots finish a game", () => {
    const stuck = board(["........", "........", "........", "........", "........", "........", "........", "...w...."], 1);
    assert.deepStrictEqual(checkersEnd(stuck, []), { end: "no_moves", winner: 0 });
    let p = checkersStart();
    const keys = [checkersKey(p)];
    let end = null;
    for (let ply = 0; ply < 300 && !end; ply++) {
      p = checkersPlay(p, checkersBotMove(p, ply % 2 ? "easy" : "normal"));
      keys.push(checkersKey(p));
      end = checkersEnd(p, keys);
    }
    assert.ok(end, "ended");
  });
});

describe("ChessRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    ChessRoom.botSpeed = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    ChessRoom.botSpeed = 1;
    await colyseus.shutdown();
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(check: () => boolean, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await wait(20);
    assert.ok(check(), "waited too long");
  }

  it("plays a whole game against a bot: the moves the room lists are the only ones it takes", async function () {
    this.timeout(60_000);
    const room: any = await colyseus.createRoom("chess", {});
    const host = await colyseus.connectTo(room);
    let t: any = null;
    host.onMessage("chess", (m) => (t = m));
    host.onMessage("chess_fx", () => {});
    host.onMessage("chess_error", () => {});
    host.send("settings", { color: "white", minutes: 1 });
    host.send("add_bot", { level: "easy" });
    await until(() => t?.seats.length === 2);
    host.send("start_game");
    await until(() => t?.phase === "playing");
    assert.strictEqual(t.seats.find((s: any) => s.id === t.me).color, 0, "the host plays white");
    host.send("move", { from: 12, to: 36 }); // e2–e5: not a move
    await wait(50);
    assert.strictEqual(t.plies, 0);
    let moves = 0;
    while (t.phase === "playing" && moves < 300) {
      if (t.turn === 0 && t.moves.length) {
        const plies = t.plies;
        const [from, to, promo] = t.moves[Math.floor(Math.random() * t.moves.length)];
        host.send("move", { from, to, promo });
        moves++;
        await until(() => t.plies > plies || t.phase !== "playing");
      } else await wait(10);
    }
    if (t.phase === "playing") host.send("resign");
    await until(() => t.phase === "gameover");
    assert.ok(t.result.reason, "ended with a reason");
  });

  it("checkers between two players: draw offers, takebacks, resign", async function () {
    this.timeout(30_000);
    const room: any = await colyseus.createRoom("chess", {});
    const a = await colyseus.connectTo(room);
    let ta: any = null, tb: any = null;
    const fx: any[] = [];
    a.onMessage("chess", (m) => (ta = m));
    a.onMessage("chess_fx", (m) => fx.push(m));
    a.onMessage("chess_error", () => {});
    await until(() => ta?.seats.length === 1);
    a.send("settings", { variant: "checkers", takebacks: true, color: "black" });
    const b = await colyseus.connectTo(room);
    b.onMessage("chess", (m) => (tb = m));
    b.onMessage("chess_fx", () => {});
    b.onMessage("chess_error", () => {});
    await until(() => ta?.seats.length === 2 && tb != null);
    a.send("start_game");
    await until(() => ta?.phase === "playing" && tb?.phase === "playing");
    assert.strictEqual(ta.turn, 1, "black moves first");
    a.send("move", { path: ta.moves[0] }); // the host is black
    await until(() => tb.plies === 1);
    a.send("takeback");
    await until(() => tb.offer?.type === "takeback");
    b.send("answer", { yes: true });
    await until(() => ta.plies === 0 && ta.offer === null);
    a.send("move", { path: ta.moves[0] });
    await until(() => tb.plies === 1);
    a.send("draw");
    await until(() => tb.offer?.type === "draw");
    b.send("answer", { yes: false });
    await until(() => fx.some((x) => x.type === "declined" && x.what === "draw"));
    b.send("resign");
    await until(() => ta.phase === "gameover");
    assert.deepStrictEqual(ta.result, { winner: 1, reason: "resign" });
    // play again, colors swapped
    a.send("play_again");
    b.send("play_again");
    await until(() => ta.phase === "playing");
    assert.strictEqual(ta.seats.find((s: any) => s.id === ta.me).color, 0);
  });
});
