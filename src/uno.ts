/**
 * UNO's cards and rules, apart from the room. A card is "<color>-<kind>": color r | y | g | b, or w for the wild
 * ones; kind 0–9, skip, rev, draw2, or for a wild: wild, draw4 ("r-7", "g-skip", "w-draw4").
 */
export type Color = "r" | "y" | "g" | "b";
export const COLORS: Color[] = ["r", "y", "g", "b"];
export type BotLevel = "easy" | "normal" | "hard";

export const colorOf = (card: string) => card[0] as Color | "w";
export const kindOf = (card: string) => card.slice(2);
export const isWild = (card: string) => card[0] === "w";
export const isDraw = (card: string) => kindOf(card) === "draw2" || kindOf(card) === "draw4";

/** The 108 cards: each color's 0 once, 1–9, skip, reverse and +2 twice; four wilds and four wild +4s. */
export function newDeck(): string[] {
  const cards: string[] = [];
  for (const c of COLORS) {
    cards.push(`${c}-0`);
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "rev", "draw2"]) cards.push(`${c}-${k}`, `${c}-${k}`);
  }
  for (let i = 0; i < 4; i++) cards.push("w-wild", "w-draw4");
  return cards;
}

export function shuffle<T>(cards: T[], rnd = Math.random): T[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** A card left in a hand at the end: a number its face, an action 20, a wild 50. */
export function points(card: string) {
  if (isWild(card)) return 50;
  const n = Number(kindOf(card));
  return Number.isInteger(n) ? n : 20;
}

/**
 * May [card] go on [top], the color asked being [color]? While a +2 or +4 waits to be drawn ([pending] > 0), only
 * the same draw card stacks on it (the room's stacking rule).
 */
export function canPlay(card: string, top: string, color: Color, pending = 0) {
  if (pending > 0) return kindOf(card) === kindOf(top) && isDraw(card);
  return isWild(card) || colorOf(card) === color || kindOf(card) === kindOf(top);
}

/** The color a hand holds most of (a wild's choice), [rnd]'s pick among none. */
export function bestColor(hand: string[], rnd = Math.random): Color {
  const count = new Map<Color, number>();
  for (const c of hand) if (!isWild(c)) count.set(colorOf(c) as Color, (count.get(colorOf(c) as Color) ?? 0) + 1);
  if (count.size === 0) return COLORS[Math.floor(rnd() * 4)];
  return [...count].sort((a, b) => b[1] - a[1])[0][0];
}

/** Does a bot challenge a +4 whose player holds [cards] (unseen)? The more he holds, the likelier a bluff: easy
 *  never, the others up to one time in two. */
export function botChallenges(level: BotLevel, cards: number, rnd = Math.random) {
  return level !== "easy" && rnd() < Math.min(0.5, Math.max(0, (cards - 2) / 12));
}

/**
 * A bot's card, or null (it draws). Easy: any card that goes. Normal: its own colors first, the heavy cards first,
 * the wilds kept for last. Hard: as normal, but when the next player is close to winning, it hits him first (+2, +4,
 * skip, reverse).
 */
export function botMove(o: { level: BotLevel; hand: string[]; top: string; color: Color; pending: number; nextCards: number }, rnd = Math.random) {
  const ok = o.hand.filter((c) => canPlay(c, o.top, o.color, o.pending));
  if (ok.length === 0) return null;
  let card: string;
  if (o.level === "easy") card = ok[Math.floor(rnd() * ok.length)];
  else {
    const attack = (c: string) => ["draw2", "draw4", "skip", "rev"].includes(kindOf(c));
    const rank = (c: string) =>
      (o.level === "hard" && o.nextCards <= 2 && attack(c) ? 1000 : 0) + (isWild(c) ? -100 : 0) + points(c);
    card = [...ok].sort((a, b) => rank(b) - rank(a))[0];
  }
  const rest = [...o.hand];
  rest.splice(rest.indexOf(card), 1);
  return { card, color: isWild(card) ? bestColor(rest, rnd) : undefined };
}
