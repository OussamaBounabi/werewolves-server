/**
 * Chess rules and the chess bot, for ChessRoom. A square is 0–63: file + 8 × rank, a1 = 0, h8 = 63. A piece is a
 * letter, white upper case (PNBRQK), black lower case; "" is an empty square. White is 0, black 1.
 */
export type Color = 0 | 1;
export type ChessPos = { board: string[]; turn: Color; castle: string; ep: number; half: number };
export type ChessMove = { from: number; to: number; promo?: string };
export type ChessEnd = "checkmate" | "stalemate" | "fifty" | "repetition" | "material";

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const sq = (f: number, r: number) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? r * 8 + f : -1);
export const colorOf = (p: string): Color | -1 => (p === "" ? -1 : p === p.toUpperCase() ? 0 : 1);
const own = (p: string, c: Color) => (c === 0 ? p.toUpperCase() : p.toLowerCase());

export function startPos(): ChessPos {
  const back = "RNBQKBNR";
  const board = Array<string>(64).fill("");
  for (let f = 0; f < 8; f++) {
    board[f] = back[f];
    board[8 + f] = "P";
    board[48 + f] = "p";
    board[56 + f] = back[f].toLowerCase();
  }
  return { board, turn: 0, castle: "KQkq", ep: -1, half: 0 };
}

/** [s] is attacked by [by]'s pieces. */
export function attacked(board: string[], s: number, by: Color): boolean {
  const f = s & 7, r = s >> 3;
  const pr = by === 0 ? r - 1 : r + 1, pawn = own("p", by);
  if (board[sq(f - 1, pr)] === pawn || board[sq(f + 1, pr)] === pawn) return true;
  for (const [df, dr] of KNIGHT) if (board[sq(f + df, r + dr)] === own("n", by)) return true;
  for (const [df, dr] of KING) if (board[sq(f + df, r + dr)] === own("k", by)) return true;
  const ray = (dirs: number[][], a: string, b: string) => {
    for (const [df, dr] of dirs) {
      for (let i = 1; ; i++) {
        const t = sq(f + df * i, r + dr * i);
        if (t < 0) break;
        const p = board[t];
        if (p === "") continue;
        if (p === a || p === b) return true;
        break;
      }
    }
    return false;
  };
  return ray(DIAG, own("b", by), own("q", by)) || ray(ORTH, own("r", by), own("q", by));
}

export const kingOf = (board: string[], c: Color) => board.indexOf(own("k", c));
export const inCheck = (pos: ChessPos) => attacked(pos.board, kingOf(pos.board, pos.turn), (1 - pos.turn) as Color);

/** Every move by the side to move, its king left in check or not. */
function pseudoMoves(pos: ChessPos): ChessMove[] {
  const { board, turn } = pos;
  const out: ChessMove[] = [];
  const enemy = (t: number) => t >= 0 && colorOf(board[t]) === 1 - turn;
  const free = (t: number) => t >= 0 && board[t] === "";
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (p === "" || colorOf(p) !== turn) continue;
    const f = s & 7, r = s >> 3, kind = p.toLowerCase();
    if (kind === "p") {
      const dir = turn === 0 ? 1 : -1, last = turn === 0 ? 7 : 0, home = turn === 0 ? 1 : 6;
      const add = (to: number) => {
        if (to >> 3 === last) for (const promo of ["q", "r", "b", "n"]) out.push({ from: s, to, promo });
        else out.push({ from: s, to });
      };
      const one = sq(f, r + dir);
      if (free(one)) {
        add(one);
        const two = sq(f, r + 2 * dir);
        if (r === home && free(two)) out.push({ from: s, to: two });
      }
      for (const df of [-1, 1]) {
        const t = sq(f + df, r + dir);
        if (enemy(t) || (t >= 0 && t === pos.ep)) add(t);
      }
    } else if (kind === "n" || kind === "k") {
      for (const [df, dr] of kind === "n" ? KNIGHT : KING) {
        const t = sq(f + df, r + dr);
        if (free(t) || enemy(t)) out.push({ from: s, to: t });
      }
    } else {
      const dirs = kind === "b" ? DIAG : kind === "r" ? ORTH : [...DIAG, ...ORTH];
      for (const [df, dr] of dirs) {
        for (let i = 1; ; i++) {
          const t = sq(f + df * i, r + dr * i);
          if (t < 0 || colorOf(board[t]) === turn) break;
          out.push({ from: s, to: t });
          if (board[t] !== "") break;
        }
      }
    }
  }
  // Castling: the king and the rook unmoved, the squares between empty, the king not in check nor crossing one.
  const by = (1 - turn) as Color, base = turn === 0 ? 0 : 56;
  const king = own("k", turn), rook = own("r", turn);
  if (board[base + 4] === king && !attacked(board, base + 4, by)) {
    if (pos.castle.includes(turn === 0 ? "K" : "k") && board[base + 7] === rook && free(base + 5) && free(base + 6) &&
      !attacked(board, base + 5, by) && !attacked(board, base + 6, by)) out.push({ from: base + 4, to: base + 6 });
    if (pos.castle.includes(turn === 0 ? "Q" : "q") && board[base] === rook && free(base + 1) && free(base + 2) && free(base + 3) &&
      !attacked(board, base + 3, by) && !attacked(board, base + 2, by)) out.push({ from: base + 4, to: base + 2 });
  }
  return out;
}

export function makeMove(pos: ChessPos, m: ChessMove): ChessPos {
  const board = pos.board.slice();
  const p = board[m.from], kind = p.toLowerCase(), turn = pos.turn;
  const capture = board[m.to] !== "" || (kind === "p" && m.to === pos.ep);
  if (kind === "p" && m.to === pos.ep) board[m.to + (turn === 0 ? -8 : 8)] = "";
  board[m.to] = m.promo ? own(m.promo, turn) : p;
  board[m.from] = "";
  if (kind === "k" && Math.abs(m.to - m.from) === 2) { // castling: the rook jumps over
    const kingSide = m.to > m.from;
    board[kingSide ? m.to - 1 : m.to + 1] = board[kingSide ? m.to + 1 : m.to - 2];
    board[kingSide ? m.to + 1 : m.to - 2] = "";
  }
  let castle = pos.castle;
  if (kind === "k") castle = castle.replace(turn === 0 ? /[KQ]/g : /[kq]/g, "");
  for (const [corner, right] of [[0, "Q"], [7, "K"], [56, "q"], [63, "k"]] as const) {
    if (m.from === corner || m.to === corner) castle = castle.replace(right, "");
  }
  return {
    board,
    turn: (1 - turn) as Color,
    castle,
    ep: kind === "p" && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : -1,
    half: kind === "p" || capture ? 0 : pos.half + 1,
  };
}

export function legalMoves(pos: ChessPos): ChessMove[] {
  return pseudoMoves(pos).filter((m) => {
    const next = makeMove(pos, m);
    return !attacked(next.board, kingOf(next.board, pos.turn), next.turn);
  });
}

/** The position for the threefold rule: the same pieces, side to move, castling rights and en passant square. */
export const posKey = (pos: ChessPos) => `${pos.board.map((p) => p || ".").join("")}${pos.turn}${pos.castle}${pos.ep}`;

/** [c] still has the pieces to checkmate with (a lone bishop or knight can't against a bare king). */
export function canMate(board: string[], c: Color): boolean {
  const mine = board.filter((p) => p !== "" && colorOf(p) === c).map((p) => p.toLowerCase());
  if (mine.some((k) => k === "p" || k === "r" || k === "q")) return true;
  const minors = mine.filter((k) => k === "n" || k === "b").length;
  if (minors >= 2) return true;
  return minors === 1 && board.some((p) => p !== "" && colorOf(p) !== c && p.toLowerCase() !== "k");
}

/** How the game ended in [pos] (the side to move has no move, a draw rule), or null: it goes on. [keys]: every position so far, this one included. */
export function chessEnd(pos: ChessPos, keys: string[]): { end: ChessEnd; winner: Color | null } | null {
  if (legalMoves(pos).length === 0) {
    return inCheck(pos) ? { end: "checkmate", winner: (1 - pos.turn) as Color } : { end: "stalemate", winner: null };
  }
  if (!canMate(pos.board, 0) && !canMate(pos.board, 1)) return { end: "material", winner: null };
  if (pos.half >= 100) return { end: "fifty", winner: null };
  const key = posKey(pos);
  if (keys.filter((k) => k === key).length >= 3) return { end: "repetition", winner: null };
  return null;
}

// ---- the bot ----

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** The position's worth for white (centipawns): material, plus where each piece stands. */
function evaluate(board: string[]): number {
  const queens = board.some((p) => p === "q" || p === "Q");
  let score = 0;
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (p === "") continue;
    const c = colorOf(p), kind = p.toLowerCase();
    const f = s & 7, r = c === 0 ? s >> 3 : 7 - (s >> 3); // the rank as its owner sees it
    const center = 3.5 - Math.max(Math.abs(f - 3.5), Math.abs((s >> 3) - 3.5)); // 0 at the edge, 3 in the middle
    let v = VALUE[kind];
    if (kind === "p") v += r * 8 + (r >= 2 && r <= 4 && (f === 3 || f === 4) ? 15 : 0);
    else if (kind === "n") v += center * 10 - 15;
    else if (kind === "b") v += center * 6;
    else if (kind === "r") v += r === 6 ? 20 : 0;
    else if (kind === "q") v += center * 2;
    else if (kind === "k") v += queens ? (r === 0 && (f <= 2 || f >= 6) ? 20 : -center * 10 - r * 8) : center * 10;
    score += c === 0 ? v : -v;
  }
  return score;
}

const MATE = 100_000;

/** Captures first, the most valuable victim by the least valuable piece; then promotions. */
function ordered(pos: ChessPos, moves: ChessMove[]) {
  const worth = (m: ChessMove) => {
    const victim = pos.board[m.to];
    return (victim ? VALUE[victim.toLowerCase()] * 10 - VALUE[pos.board[m.from].toLowerCase()] : 0) + (m.promo === "q" ? 8000 : 0);
  };
  return moves.map((m) => [worth(m), m] as const).sort((a, b) => b[0] - a[0]).map(([, m]) => m);
}

class Search {
  nodes = 0;
  stopped = false;
  constructor(private deadline: number) {}

  private tick() {
    if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) this.stopped = true;
  }

  /** Only captures, until the position is quiet (so the bot doesn't stop a search in the middle of an exchange). */
  quiet(pos: ChessPos, alpha: number, beta: number, depth: number): number {
    this.tick();
    const stand = (pos.turn === 0 ? 1 : -1) * evaluate(pos.board);
    if (stand >= beta || depth === 0) return stand;
    alpha = Math.max(alpha, stand);
    for (const m of ordered(pos, legalMoves(pos).filter((m) => pos.board[m.to] !== "" || m.promo))) {
      const v = -this.quiet(makeMove(pos, m), -beta, -alpha, depth - 1);
      if (this.stopped) return 0;
      if (v >= beta) return v;
      alpha = Math.max(alpha, v);
    }
    return alpha;
  }

  /** Negamax with alpha-beta: the best the side to move can get in [depth] moves. */
  value(pos: ChessPos, depth: number, alpha: number, beta: number, ply: number, quiescence: boolean): number {
    this.tick();
    const moves = legalMoves(pos);
    if (moves.length === 0) return inCheck(pos) ? -MATE + ply : 0;
    if (pos.half >= 100) return 0;
    if (depth === 0) return quiescence ? this.quiet(pos, alpha, beta, 4) : (pos.turn === 0 ? 1 : -1) * evaluate(pos.board);
    let best = -Infinity;
    for (const m of ordered(pos, moves)) {
      const v = -this.value(makeMove(pos, m), depth - 1, -beta, -alpha, ply + 1, quiescence);
      if (this.stopped) return 0;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }
}

export type BotLevel = "easy" | "normal" | "hard";
/** How a bot plays: how deep it looks, how much it misjudges (centipawns), how often it plays at random, how long. */
type BotParams = { depth: number; noise: number; random: number; quiescence: boolean; ms: number };
const LEVEL: Record<BotLevel, BotParams> = {
  easy: { depth: 1, noise: 90, random: 0.25, quiescence: false, ms: 300 },
  normal: { depth: 2, noise: 25, random: 0, quiescence: true, ms: 700 },
  hard: { depth: 4, noise: 0, random: 0, quiescence: true, ms: 1500 },
};

/**
 * The ratings a chess bot may play at (the host picks one); above FREE_RATING only for a VIP Pro host. Stockfish plays
 * from ENGINE_ELO.min (1320) up; below it, our own bot, made weaker step by step.
 */
export const CHESS_RATINGS = [400, 600, 800, 1000, 1200, 1500, 1800, 2100, 2400, 2800];
export const FREE_RATING = 1500;
const RATED: Record<number, BotParams> = {
  400: { depth: 1, noise: 220, random: 0.45, quiescence: false, ms: 300 },
  600: { depth: 1, noise: 120, random: 0.3, quiescence: false, ms: 300 },
  800: { depth: 1, noise: 70, random: 0.15, quiescence: false, ms: 400 },
  1000: { depth: 2, noise: 40, random: 0.05, quiescence: true, ms: 600 },
  1200: { depth: 3, noise: 15, random: 0, quiescence: true, ms: 1000 },
};

/** Our own bot's play for a rating it can manage (null: Stockfish's, above 1200). */
export const ratedBot = (rating: number): BotParams | null => RATED[rating] ?? null;

/** The bot's move at [level]: easy blunders now and then, hard looks four moves deep (deepening while time allows). */
export function chessBotMove(pos: ChessPos, level: BotLevel | BotParams, rnd: () => number = Math.random): ChessMove {
  const moves = legalMoves(pos);
  const L = typeof level === "string" ? LEVEL[level] : level;
  if (moves.length === 1 || rnd() < L.random) return moves[Math.floor(rnd() * moves.length)];
  const search = new Search(Date.now() + L.ms);
  let best = moves[0], scored: [number, ChessMove][] = [];
  for (let depth = 1; depth <= L.depth; depth++) {
    const round: [number, ChessMove][] = [];
    // (the last depth's best first: alpha-beta cuts more)
    for (const m of [best, ...moves.filter((x) => x !== best)]) {
      const v = -search.value(makeMove(pos, m), depth - 1, -MATE * 2, MATE * 2, 1, L.quiescence);
      if (search.stopped) break;
      round.push([v + (rnd() - 0.5) * 2 * L.noise, m]);
    }
    if (search.stopped && round.length < moves.length) break; // (an unfinished depth isn't trusted)
    scored = round.sort((a, b) => b[0] - a[0]);
    best = scored[0][1];
  }
  return best;
}

/** The bot, offered a draw: it takes it when it's behind (by its own reckoning, a pawn and a half). */
export const chessBotTakesDraw = (pos: ChessPos, bot: Color) => (bot === 0 ? 1 : -1) * evaluate(pos.board) < -150;

// ---- notation (the analysis board, the engine, saved games) ----

const FILES = "abcdefgh";

/** "e4" for a square (0 = a1, 63 = h8). */
export const square = (s: number) => `${FILES[s & 7]}${(s >> 3) + 1}`;

/** A move as the engines write it: "e2e4", "e7e8q". */
export const uci = (m: ChessMove) => `${square(m.from)}${square(m.to)}${m.promo ?? ""}`;

/** The legal move [text] stands for in [pos] ("e2e4"), or undefined. */
export const fromUci = (pos: ChessPos, text: string) => legalMoves(pos).find((m) => uci(m) === text);

/** A move as players read it: "Nf3", "exd5", "O-O", "e8=Q+", "Qh5#" (only as much of the origin as it takes). */
export function san(pos: ChessPos, m: ChessMove): string {
  const p = pos.board[m.from], kind = p.toLowerCase();
  let text: string;
  if (kind === "k" && Math.abs(m.to - m.from) === 2) text = m.to > m.from ? "O-O" : "O-O-O";
  else {
    const capture = pos.board[m.to] !== "" || (kind === "p" && m.to === pos.ep);
    if (kind === "p") {
      text = `${capture ? `${FILES[m.from & 7]}x` : ""}${square(m.to)}${m.promo ? `=${m.promo.toUpperCase()}` : ""}`;
    } else {
      const rivals = legalMoves(pos).filter((x) => x.to === m.to && x.from !== m.from && pos.board[x.from] === p);
      let from = "";
      if (rivals.length) {
        if (!rivals.some((x) => (x.from & 7) === (m.from & 7))) from = FILES[m.from & 7];
        else if (!rivals.some((x) => x.from >> 3 === m.from >> 3)) from = `${(m.from >> 3) + 1}`;
        else from = square(m.from);
      }
      text = `${kind.toUpperCase()}${from}${capture ? "x" : ""}${square(m.to)}`;
    }
  }
  const next = makeMove(pos, m);
  return inCheck(next) ? `${text}${legalMoves(next).length === 0 ? "#" : "+"}` : text;
}

/** The position as FEN (what an engine reads); [ply]: moves played from the start (the move number). */
export function fen(pos: ChessPos, ply = 0): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = "", empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 8 + f];
      if (p === "") empty++;
      else {
        if (empty) row += empty;
        row += p;
        empty = 0;
      }
    }
    rows.push(empty ? row + empty : row);
  }
  const ep = pos.ep >= 0 ? square(pos.ep) : "-";
  return `${rows.join("/")} ${pos.turn === 0 ? "w" : "b"} ${pos.castle || "-"} ${ep} ${pos.half} ${Math.floor(ply / 2) + 1}`;
}
