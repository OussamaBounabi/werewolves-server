/**
 * A pretend Stockfish for the tests (run with tsx): it speaks enough UCI and plays the first legal move of the
 * position (our own rules), scoring it +25 for the side to move. `node --import tsx test/fake-stockfish.ts`.
 */
import { createInterface } from "node:readline";
import { fromUci, legalMoves, makeMove, uci, type ChessPos } from "../src/chess.js";

function parseFen(text: string): ChessPos {
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

let pos: ChessPos | null = null;
const say = (line: string) => process.stdout.write(`${line}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "uci") return say("id name FakeFish\nuciok");
  if (line === "isready") return say("readyok");
  if (line === "quit") process.exit(0);
  if (line.startsWith("position fen ")) {
    const [fen, moves] = line.slice(13).split(" moves ");
    pos = parseFen(fen);
    for (const m of moves?.split(" ") ?? []) pos = makeMove(pos, fromUci(pos, m)!);
  }
  if (line.startsWith("go") && pos) {
    const m = legalMoves(pos)[0];
    if (!m) return say("bestmove (none)");
    say(`info depth 7 multipv 1 score cp 25 nodes 100 pv ${uci(m)}`);
    say(`bestmove ${uci(m)}`);
  }
});
