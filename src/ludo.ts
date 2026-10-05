/**
 * Ludo rules, without the room. The track has 52 squares, numbered clockwise from red's start square.
 * A pawn's progress, counted from its own start: -1 in the base, 0–50 on the track, 51–55 up its home
 * column, 56 home. Colors (clockwise): 0 red, 1 green, 2 yellow, 3 blue.
 */
export const TRACK = 52;
export const LAST_TRACK = 50; // the last square before the home column
export const HOME = 56;
export const OFFSETS = [0, 13, 26, 39]; // each color's start square
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]); // the start squares and the stars

export type BotLevel = "easy" | "normal" | "hard";
/** Where everyone's pawns are: color → progress of each pawn. */
export type Board = Map<number, number[]>;

/** The track square a pawn stands on, or -1 (base, home column, home). */
export function square(color: number, p: number) {
  return p >= 0 && p <= LAST_TRACK ? (p + OFFSETS[color]) % TRACK : -1;
}

/** Where a pawn gets with this roll, or null: out of the base takes a 6; home takes the exact number. */
export function target(p: number, roll: number): number | null {
  if (p === HOME) return null;
  if (p < 0) return roll === 6 ? 0 : null;
  return p + roll <= HOME ? p + roll : null;
}

/** The pawns of [color] that can move with [roll]; pawns standing together count once. */
export function movable(pawns: number[], roll: number) {
  const seen = new Set<number>();
  const out: number[] = [];
  pawns.forEach((p, i) => {
    if (target(p, roll) === null || seen.has(p)) return;
    seen.add(p);
    out.push(i);
  });
  return out;
}

/** The pawns a move to [to] would catch: others' pawns on that square, unless it's safe (or a partner's). */
export function victims(board: Board, color: number, to: number, friends: (other: number) => boolean) {
  const sq = square(color, to);
  const out: { color: number; pawn: number }[] = [];
  if (sq < 0 || SAFE.has(sq)) return out;
  for (const [c, pawns] of board) {
    if (c === color || friends(c)) continue;
    pawns.forEach((p, i) => square(c, p) === sq && out.push({ color: c, pawn: i }));
  }
  return out;
}

/** How many enemy pawns could reach track square [sq] with one roll (stars and starts are safe). */
function threats(board: Board, color: number, sq: number, friends: (other: number) => boolean) {
  if (sq < 0 || SAFE.has(sq)) return 0;
  let n = 0;
  for (const [c, pawns] of board) {
    if (c === color || friends(c)) continue;
    for (const p of pawns) {
      const at = square(c, p);
      if (at < 0) continue;
      const d = (sq - at + TRACK) % TRACK;
      if (d >= 1 && d <= 6 && p + d <= LAST_TRACK) n++;
    }
  }
  return n;
}

/**
 * A bot's move: easy picks at random; normal and hard weigh catching, getting home, leaving the base,
 * safe squares — hard also runs from danger and won't step in front of an enemy. Always catches.
 */
export function botMove(level: BotLevel, board: Board, color: number, roll: number, friends: (other: number) => boolean) {
  const pawns = board.get(color)!;
  const options = movable(pawns, roll);
  if (options.length === 0) return null;
  if (level === "easy") return options[Math.floor(Math.random() * options.length)];
  let best = options[0], bestScore = -Infinity;
  for (const i of options) {
    const from = pawns[i], to = target(from, roll)!;
    const caught = victims(board, color, to, friends);
    let score = to / 10;
    if (to === HOME) score += 70;
    if (caught.length) score += 90 + (level === "hard" ? Math.max(...caught.map((v) => board.get(v.color)![v.pawn])) / 2 : 0);
    if (from < 0) score += 60;
    if (to > LAST_TRACK && from <= LAST_TRACK) score += 35; // into the home column: out of reach
    if (SAFE.has(square(color, to))) score += 20;
    if (level === "hard") {
      score -= 30 * Math.min(2, threats(board, color, square(color, to), friends));
      score += 25 * Math.min(2, threats(board, color, square(color, from), friends));
    }
    if (score > bestScore) (best = i), (bestScore = score);
  }
  return best;
}
