/**
 * Algerian rummy cards and melds, shared by the room and its tests.
 *
 * Cards are numbers: 0–103 are two 52-card decks (suit = (c % 52) / 13: 0 ♠, 1 ♥, 2 ♦, 3 ♣;
 * rank = c % 13 + 1: 1 ace … 11 jack, 12 queen, 13 king), 104–107 the four jokers.
 */
export const DECK_SIZE = 108;
export const isJoker = (c: number) => c >= 104;
export const rankOf = (c: number) => (c % 13) + 1;
export const suitOf = (c: number) => Math.floor((c % 52) / 13);

export type MeldKind = "set" | "run";
/**
 * A valid meld: its cards in table order (jokers in the place they stand for), its points without
 * the jokers, and [full]: with each joker worth the card it stands for.
 */
export type Meld = { kind: MeldKind; cards: number[]; points: number; full: number };

/** The table's rules, set by the host in the waiting room. */
export type Rules = {
  needRun: boolean; // the opening needs a run without a joker (5-6-7), not only sets
  raiseOpening: boolean; // each opening must beat the last one: 106 → the next needs 107
  openWithDiscard: boolean; // the opening must use a card taken from the discard pile
  jokerPoints: boolean; // jokers count toward the opening (worth the card they stand for)
  oneJoker: boolean; // at most one joker in a meld
  maxFive: boolean; // melds are laid down with 5 cards at most (adding to them later is free)
  jokerDouble: boolean; // going out with a joker doubles the penalties
  jokerSwap: boolean; // a real card can take a joker's place on the table
  addToOthers: boolean; // cards can be added to other players' melds
  noDiscardOnLast: boolean; // a player with one card left can't take the discard
  teamRun: boolean; // 2 vs 2: once my partner opened, I still need a run without a joker to lay mine
  teamCleanMeld: boolean; // 2 vs 2: once my partner opened, I need at least one meld without a joker to lay mine
};
export const DEFAULT_RULES: Rules = {
  needRun: true,
  raiseOpening: true,
  openWithDiscard: false,
  jokerPoints: false,
  oneJoker: true,
  maxFive: true,
  jokerDouble: true,
  jokerSwap: true,
  addToOthers: true,
  noDiscardOnLast: true,
  teamRun: false,
  teamCleanMeld: true,
};

const jokersIn = (m: { cards: number[] }) => m.cards.filter(isJoker).length;

/** Why this meld can't be laid down under [rules] ("" when it can). */
export function layError(m: Meld, rules: Rules): string {
  if (rules.oneJoker && jokersIn(m) > 1) return "two_jokers";
  if (rules.maxFive && m.cards.length > 5) return "too_long";
  return "";
}

/** The opening's points: melds without a joker, or every meld when jokers count. */
export function openingPoints(melds: Meld[], rules: Rules): number {
  return melds.reduce((n, m) => n + (rules.jokerPoints ? m.full : jokersIn(m) === 0 ? m.points : 0), 0);
}

/** 2 vs 2, my partner opened: why I can't lay these melds ("" when I can) — no points needed. */
export function teamLayError(melds: Meld[], rules: Rules): string {
  if (rules.teamRun && !melds.some((m) => m.kind === "run" && jokersIn(m) === 0)) return "need_run";
  if (rules.teamCleanMeld && !melds.some((m) => jokersIn(m) === 0)) return "need_clean";
  return "";
}

/** Why these melds can't open ("" when they can): a real run when required, and enough points. */
export function openingError(melds: Meld[], need: number, rules: Rules): string {
  if (rules.needRun && !melds.some((m) => m.kind === "run" && jokersIn(m) === 0)) return "need_run";
  return openingPoints(melds, rules) >= need ? "" : "below_threshold";
}

/** A run position's value: 1 is the low ace, 14 the high ace (Q-K-A). */
const runPoints = (v: number) => (v === 1 ? 1 : v === 14 ? 11 : Math.min(v, 10));
/** In a set the ace counts 11 (A-A-A), faces 10. */
const setPoints = (rank: number) => (rank === 1 ? 11 : Math.min(rank, 10));

export function shuffled(): number[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** What these cards make: a set (3–4 of a rank, all suits different) or a run (3+ in a row, one suit). */
export function meldOf(cards: number[]): Meld | null {
  return setOf(cards) ?? runOf(cards);
}

function setOf(cards: number[]): Meld | null {
  const real = cards.filter((c) => !isJoker(c));
  if (cards.length < 3 || cards.length > 4 || real.length < 2) return null;
  const rank = rankOf(real[0]);
  if (real.some((c) => rankOf(c) !== rank)) return null;
  if (new Set(real.map(suitOf)).size !== real.length) return null;
  const sorted = [...real].sort((a, b) => suitOf(a) - suitOf(b));
  return {
    kind: "set",
    cards: [...sorted, ...cards.filter(isJoker)],
    points: real.length * setPoints(rank),
    full: cards.length * setPoints(rank),
  };
}

function runOf(cards: number[]): Meld | null {
  const real = cards.filter((c) => !isJoker(c));
  const jokers = cards.filter(isJoker);
  if (cards.length < 3 || cards.length > 14 || real.length < 2) return null;
  if (real.some((c) => suitOf(c) !== suitOf(real[0]))) return null;
  const aces = real.filter((c) => rankOf(c) === 1).length;
  // Aces go low (A-2-3), high (Q-K-A), or one each end (A…K-A).
  for (const high of aces === 2 ? [0, 2, 1] : [0, aces]) {
    let aceSeen = 0;
    const valued = real
      .map((c) => ({ c, v: rankOf(c) === 1 ? (aceSeen++ < aces - high ? 1 : 14) : rankOf(c) }))
      .sort((a, b) => a.v - b.v);
    if (valued.some((x, i) => i > 0 && x.v === valued[i - 1].v)) continue;
    let start = valued[0].v, end = valued[valued.length - 1].v;
    let spare = jokers.length - (end - start + 1 - real.length);
    if (spare < 0) continue;
    while (spare > 0 && end < 14) (end++, spare--); // extra jokers go on the high end first
    while (spare > 0 && start > 1) (start--, spare--);
    if (spare > 0) continue;
    const ordered: number[] = [];
    let points = 0, full = 0, j = 0;
    for (let v = start; v <= end; v++) {
      const at = valued.find((x) => x.v === v);
      ordered.push(at ? at.c : jokers[j++]);
      if (at) points += runPoints(v);
      full += runPoints(v);
    }
    return { kind: "run", cards: ordered, points, full };
  }
  return null;
}

/** The card a joker at [index] of a table meld stands for — any card that fits (for sets: a missing suit). */
export function jokerFits(meld: { kind: MeldKind; cards: number[] }, index: number, card: number): boolean {
  if (isJoker(card) || !isJoker(meld.cards[index])) return false;
  const real = meld.cards.filter((c) => !isJoker(c));
  if (meld.kind === "set") return rankOf(card) === rankOf(real[0]) && !real.some((c) => suitOf(c) === suitOf(card));
  if (suitOf(card) !== suitOf(real[0])) return false;
  // The run's first value, from a card that isn't an ace (an ace could be low or high).
  const anchor = meld.cards.findIndex((c) => !isJoker(c) && rankOf(c) !== 1);
  const v = rankOf(meld.cards[anchor]) - anchor + index;
  return rankOf(card) === (v === 14 ? 1 : v);
}
