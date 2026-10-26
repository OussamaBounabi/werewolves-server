/**
 * Checkers (8×8) and its bot, for ChessRoom. Squares as in chess (a1 = 0, h8 = 63); the played ones are those with
 * file + rank odd (each player's near left corner is a light square, the board turned from chess's). White men "w"
 * start on ranks 1–3 and move up, black men "b" on ranks 6–8 and move down, one square, capturing forward only.
 * Kings "W" / "B" fly: any distance on any diagonal, and they capture from afar too (over one piece, landing on any
 * empty square beyond it). Black moves first. A man reaching the far rank is crowned and his move ends there.
 * Captures are forced (unless the room turns that off), a capture goes on while it can, and a piece taken stays on
 * the board until the move ends (it can't be jumped twice).
 */
export type Color = 0 | 1; // 0 white, 1 black
export type CheckersPos = { board: string[]; turn: Color; quiet: number };
export type CheckersMove = { path: number[]; captures: number[] };
export type CheckersEnd = "no_moves" | "quiet" | "repetition";

const sq = (f: number, r: number) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1);
export const colorOf = (p: string): Color | -1 => (p === "" ? -1 : p.toLowerCase() === "w" ? 0 : 1);
const isKing = (p: string) => p === "W" || p === "B";
const lastRank = (c: Color) => (c === 0 ? 7 : 0);
const QUIET_DRAW = 80; // 40 moves each with no capture and no man moving: a draw

export function checkersStart(): CheckersPos {
  const board = Array<string>(64).fill("");
  for (let s = 0; s < 64; s++) {
    const r = s >> 3;
    if (((s & 7) + r) % 2 === 0) continue; // (the light squares: played)
    if (r <= 2) board[s] = "w";
    else if (r >= 5) board[s] = "b";
  }
  return { board, turn: 1, quiet: 0 };
}

const dirsOf = (p: string) => {
  const forward = colorOf(p) === 0 ? 1 : -1;
  return isKing(p) ? [[1, 1], [-1, 1], [1, -1], [-1, -1]] : [[1, forward], [-1, forward]];
};

/** Every full capture by the piece on [path]'s first square ([path] and [taken] so far): it goes on while it can. */
function jumps(board: string[], piece: string, path: number[], taken: number[], out: CheckersMove[]) {
  const s = path[path.length - 1], f = s & 7, r = s >> 3, c = colorOf(piece) as Color, king = isKing(piece);
  const free = (t: number) => t >= 0 && (board[t] === "" || t === path[0]); // (the square it left is empty now)
  let more = false;
  for (const [df, dr] of dirsOf(piece)) {
    let i = 1;
    if (king) while (free(sq(f + df * i, r + dr * i))) i++; // a king looks down the whole diagonal
    const mid = sq(f + df * i, r + dr * i);
    if (mid < 0 || colorOf(board[mid]) !== 1 - c || taken.includes(mid)) continue;
    for (let j = i + 1; free(sq(f + df * j, r + dr * j)); j++) {
      const land = sq(f + df * j, r + dr * j);
      more = true;
      if (!king && land >> 3 === lastRank(c)) out.push({ path: [...path, land], captures: [...taken, mid] }); // crowned: it stops
      else jumps(board, piece, [...path, land], [...taken, mid], out);
      if (!king) break; // a man lands just behind
    }
  }
  if (!more && taken.length > 0) out.push({ path, captures: taken });
}

/** The moves of the side to move. [forced]: when a capture exists, only captures. */
export function checkersMoves(pos: CheckersPos, forced = true): CheckersMove[] {
  const caps: CheckersMove[] = [], steps: CheckersMove[] = [];
  for (let s = 0; s < 64; s++) {
    const p = pos.board[s];
    if (colorOf(p) !== pos.turn) continue;
    jumps(pos.board, p, [s], [], caps);
    for (const [df, dr] of dirsOf(p)) {
      for (let i = 1; ; i++) {
        const t = sq((s & 7) + df * i, (s >> 3) + dr * i);
        if (t < 0 || pos.board[t] !== "") break;
        steps.push({ path: [s, t], captures: [] });
        if (!isKing(p)) break; // a man: one square; a king flies on
      }
    }
  }
  return forced && caps.length > 0 ? caps : [...caps, ...steps];
}

export function checkersPlay(pos: CheckersPos, m: CheckersMove): CheckersPos {
  const board = pos.board.slice();
  const from = m.path[0], to = m.path[m.path.length - 1];
  let p = board[from];
  const man = !isKing(p);
  board[from] = "";
  for (const t of m.captures) board[t] = "";
  if (man && to >> 3 === lastRank(colorOf(p) as Color)) p = p.toUpperCase();
  board[to] = p;
  return { board, turn: (1 - pos.turn) as Color, quiet: man || m.captures.length > 0 ? 0 : pos.quiet + 1 };
}

export const checkersKey = (pos: CheckersPos) => `${pos.board.map((p) => p || ".").join("")}${pos.turn}`;

export const sameMove = (a: CheckersMove, path: number[]) =>
  a.path.length === path.length && a.path.every((s, i) => s === path[i]);

/** How the game ended in [pos], or null. The side to move with no move (no pieces, or all blocked) loses. */
export function checkersEnd(pos: CheckersPos, keys: string[], forced = true): { end: CheckersEnd; winner: Color | null } | null {
  if (checkersMoves(pos, forced).length === 0) return { end: "no_moves", winner: (1 - pos.turn) as Color };
  if (pos.quiet >= QUIET_DRAW) return { end: "quiet", winner: null };
  const key = checkersKey(pos);
  if (keys.filter((k) => k === key).length >= 3) return { end: "repetition", winner: null };
  return null;
}

// ---- the bot ----

/** The position's worth for white: kings count more than men, men gain as they go forward and guard their back row. */
function evaluate(board: string[]): number {
  let score = 0;
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (p === "") continue;
    const c = colorOf(p) as Color, f = s & 7, r = c === 0 ? s >> 3 : 7 - (s >> 3);
    let v = isKing(p) ? 280 : 100 + r * 4 + (r === 0 ? 8 : 0);
    if (f >= 2 && f <= 5 && (s >> 3) >= 2 && (s >> 3) <= 5) v += 4;
    score += c === 0 ? v : -v;
  }
  return score;
}

const WIN = 100_000;

class Search {
  private nodes = 0;
  stopped = false;
  constructor(private deadline: number, private forced: boolean) {}

  value(pos: CheckersPos, depth: number, alpha: number, beta: number, ply: number): number {
    if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) this.stopped = true;
    const moves = checkersMoves(pos, this.forced);
    if (moves.length === 0) return -WIN + ply;
    // (a capture to answer: looked at one move further, so the bot doesn't stop in the middle of an exchange)
    if (depth <= 0 && !(moves[0].captures.length > 0 && depth > -4)) return (pos.turn === 0 ? 1 : -1) * evaluate(pos.board);
    let best = -Infinity;
    for (const m of [...moves].sort((a, b) => b.captures.length - a.captures.length)) {
      const v = -this.value(checkersPlay(pos, m), depth - 1, -beta, -alpha, ply + 1);
      if (this.stopped) return 0;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }
}

export type BotLevel = "easy" | "normal" | "hard";
const LEVEL: Record<BotLevel, { depth: number; noise: number; random: number; ms: number }> = {
  easy: { depth: 2, noise: 40, random: 0.3, ms: 300 },
  normal: { depth: 5, noise: 10, random: 0, ms: 700 },
  hard: { depth: 10, noise: 0, random: 0, ms: 1500 },
};

export function checkersBotMove(pos: CheckersPos, level: BotLevel, forced = true, rnd: () => number = Math.random): CheckersMove {
  const moves = checkersMoves(pos, forced);
  const L = LEVEL[level];
  if (moves.length === 1 || rnd() < L.random) return moves[Math.floor(rnd() * moves.length)];
  const search = new Search(Date.now() + L.ms, forced);
  let best = moves[0];
  for (let depth = 1; depth <= L.depth; depth++) {
    const round: [number, CheckersMove][] = [];
    for (const m of [best, ...moves.filter((x) => x !== best)]) {
      const v = -search.value(checkersPlay(pos, m), depth - 1, -WIN * 2, WIN * 2, 1);
      if (search.stopped) break;
      round.push([v + (rnd() - 0.5) * 2 * L.noise, m]);
    }
    if (search.stopped && round.length < moves.length) break;
    best = round.sort((a, b) => b[0] - a[0])[0][1];
  }
  return best;
}

export const checkersBotTakesDraw = (pos: CheckersPos, bot: Color) => (bot === 0 ? 1 : -1) * evaluate(pos.board) < -150;
