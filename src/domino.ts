/**
 * Double-six dominoes: 28 tiles, numbered 0–27 by (lo, hi) with lo ≤ hi: 0-0, 0-1 … 0-6, 1-1 … 6-6.
 * The line on the table grows from the first tile at both ends; [Arm] entries go outward from it.
 */
export const TILES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let lo = 0; lo <= 6; lo++) for (let hi = lo; hi <= 6; hi++) out.push([lo, hi]);
  return out;
})();

export const pips = (t: number) => TILES[t][0] + TILES[t][1];
export const isDouble = (t: number) => TILES[t][0] === TILES[t][1];
export const hasNumber = (t: number, n: number) => TILES[t][0] === n || TILES[t][1] === n;
export const otherEnd = (t: number, n: number) => (TILES[t][0] === n ? TILES[t][1] : TILES[t][0]);

export function shuffledTiles(): number[] {
  const tiles = TILES.map((_, i) => i);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

/** A tile on one arm of the line: [inner] touches the line, [outer] is the new end. */
export type Placed = { tile: number; inner: number; outer: number };
export type Line = { first: number | null; left: Placed[]; right: Placed[] };

export function ends(line: Line): [number, number] | null {
  if (line.first === null) return null;
  const [lo, hi] = TILES[line.first];
  return [line.left.at(-1)?.outer ?? lo, line.right.at(-1)?.outer ?? hi];
}

/** The sides a tile can go on (both on an empty table). */
export function sidesFor(line: Line, tile: number): ("left" | "right")[] {
  const e = ends(line);
  if (!e) return ["right"];
  const out: ("left" | "right")[] = [];
  if (hasNumber(tile, e[0])) out.push("left");
  if (hasNumber(tile, e[1])) out.push("right");
  return out;
}

export function playable(line: Line, hand: number[]): number[] {
  return hand.filter((t) => sidesFor(line, t).length > 0);
}

/** Puts a tile on the line (it must fit that side). */
export function place(line: Line, tile: number, side: "left" | "right"): void {
  const e = ends(line);
  if (!e) {
    line.first = tile;
    return;
  }
  const end = side === "left" ? e[0] : e[1];
  line[side].push({ tile, inner: end, outer: otherEnd(tile, end) });
}

/** The highest double in these hands (6-6 first), else the heaviest tile: who starts round 1, with it. */
export function opener(hands: Map<string, number[]>): { id: string; tile: number } | null {
  let best: { id: string; tile: number; key: number } | null = null;
  for (const [id, hand] of hands) {
    for (const t of hand) {
      const key = isDouble(t) ? 100 + pips(t) : pips(t);
      if (!best || key > best.key) best = { id, tile: t, key };
    }
  }
  return best && { id: best.id, tile: best.tile };
}

// ---- the bot ----

export type BotLevel = "easy" | "normal" | "hard";
export type DominoView = {
  level: BotLevel;
  hand: number[];
  line: Line;
  forced: number | null; // the tile the round must start with
  opponentsLack: Set<number>; // numbers an opponent passed or drew on (he has none)
  partnerLacks: Set<number>; // 2 vs 2: numbers the partner has none of
};

/**
 * Which tile, on which side (null: nothing fits). Easy: any tile. Normal: the heaviest (fewer dots
 * left if someone else goes out). Hard: also keeps numbers it holds many of at the ends, closes the
 * line on numbers an opponent has none of, and keeps it open for its partner.
 */
export function botMove(view: DominoView): { tile: number; side: "left" | "right" } | null {
  if (view.forced !== null) return view.hand.includes(view.forced) ? { tile: view.forced, side: "right" } : null;
  const moves = view.hand.flatMap((tile) => sidesFor(view.line, tile).map((side) => ({ tile, side })));
  if (moves.length === 0) return null;
  if (view.level === "easy") return moves[Math.floor(Math.random() * moves.length)];
  const e = ends(view.line);
  const score = (m: { tile: number; side: "left" | "right" }) => {
    let s = pips(m.tile) + (isDouble(m.tile) ? 2 : 0);
    if (view.level !== "hard" || !e) return s;
    const outer = otherEnd(m.tile, m.side === "left" ? e[0] : e[1]);
    const rest = view.hand.filter((t) => t !== m.tile);
    s += 2 * rest.filter((t) => hasNumber(t, outer)).length; // it can follow up on that end
    if (view.opponentsLack.has(outer)) s += 5; // an opponent will have to draw or pass
    if (view.partnerLacks.has(outer)) s -= 5;
    return s;
  };
  return moves.reduce((best, m) => (score(m) > score(best) ? m : best));
}
