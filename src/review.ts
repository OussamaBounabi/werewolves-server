import { attacked, makeMove, type ChessMove, type ChessPos, type Color } from "./chess.js";

/**
 * The game review (after Lichess's published method; chess.com's isn't): each position's engine score as a chance of
 * winning, each move judged by the chance it gave away, each player's accuracy, and a rating guessed from it.
 */

/** The engine's view of a position, for the side to move: centipawns or a mate in n (negative: he's mated). */
export type Score = { cp?: number; mate?: number };

/** The side to move's chance of winning, 0–100. */
export function winChance(s: Score): number {
  if (s.mate !== undefined) return s.mate > 0 ? 100 : 0;
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** A move's accuracy (0–100) from the winning chance it lost. */
export const moveAccuracy = (loss: number) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));

export type Mark = "brilliant" | "great" | "best" | "excellent" | "good" | "inaccuracy" | "mistake" | "blunder";

/**
 * A move's mark. [loss]: the winning chance it lost; [best]: it's the engine's move; [onlyMove]: the engine's second
 * choice was far worse (an only move); [sacrifice]: it leaves the moved piece hanging; [after]: the chance left.
 */
export function mark({ loss, best, onlyMove, sacrifice, after }: { loss: number; best: boolean; onlyMove: boolean; sacrifice: boolean; after: number }): Mark {
  if (best && sacrifice && after >= 40) return "brilliant";
  if (best && onlyMove) return "great";
  if (best) return "best";
  if (loss >= 20) return "blunder";
  if (loss >= 10) return "mistake";
  if (loss >= 5) return "inaccuracy";
  return loss < 2 ? "excellent" : "good";
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** The move leaves the piece it moved (not a pawn) where the other side takes it and it's worth more than nothing back. */
export function isSacrifice(pos: ChessPos, m: ChessMove): boolean {
  const piece = (m.promo ?? pos.board[m.from]).toLowerCase();
  if (piece === "p" || piece === "k") return false;
  const next = makeMove(pos, m);
  const me = pos.turn, them = (1 - me) as Color;
  if (!attacked(next.board, m.to, them)) return false;
  const taken = VALUE[(pos.board[m.to] || " ").toLowerCase()] ?? 0;
  return !attacked(next.board, m.to, me) || VALUE[piece] - taken >= 2;
}

/** A rating guessed from a game's accuracy (a rough scale: 50% ≈ 400, 70% ≈ 1200, 90% ≈ 2200, 98% ≈ 2900). */
export function ratingFromAccuracy(accuracy: number): number {
  const scale: [number, number][] = [[0, 100], [50, 400], [60, 800], [70, 1200], [80, 1600], [85, 1900], [90, 2200], [95, 2600], [98, 2900], [100, 3100]];
  for (let i = 1; i < scale.length; i++) {
    const [a1, r1] = scale[i - 1], [a2, r2] = scale[i];
    if (accuracy <= a2) return Math.round((r1 + ((accuracy - a1) / (a2 - a1)) * (r2 - r1)) / 50) * 50;
  }
  return 3100;
}

/** One position of the game as the engine saw it: its two best lines (the first move of each, the score). */
export type Seen = { best: string; score: Score; second?: Score };

/**
 * The review of a game: [positions] before each move and the last, [moves] the moves played (UCI), [seen] the engine
 * on each position. Each move's mark, and each side's accuracy, estimated rating and count of each mark.
 */
export function review(positions: ChessPos[], moves: { uci: string; move: ChessMove }[], seen: Seen[]) {
  const marks: Mark[] = [];
  const losses: number[][] = [[], []];
  moves.forEach(({ uci, move }, i) => {
    const pos = positions[i], side = pos.turn;
    const before = winChance(seen[i].score);
    const after = 100 - winChance(seen[i + 1].score); // (the next position's side to move is the other one)
    const loss = Math.max(0, before - after);
    const onlyMove = seen[i].second !== undefined && before - winChance(seen[i].second!) >= 15;
    marks.push(mark({ loss, best: uci === seen[i].best, onlyMove, sacrifice: isSacrifice(pos, move), after }));
    losses[side].push(uci === seen[i].best ? 0 : loss);
  });
  const side = (c: Color) => {
    const accuracy = losses[c].length ? losses[c].reduce((a, l) => a + moveAccuracy(l), 0) / losses[c].length : 100;
    const counts: Partial<Record<Mark, number>> = {};
    marks.forEach((m, i) => positions[i].turn === c && (counts[m] = (counts[m] ?? 0) + 1));
    return { accuracy: Math.round(accuracy * 10) / 10, rating: ratingFromAccuracy(accuracy), counts };
  };
  return { marks, white: side(0), black: side(1) };
}

