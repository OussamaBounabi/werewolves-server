import {
  isJoker, jokerFits, layError, meldOf, openingError, rankOf, suitOf, teamLayError, type Meld, type MeldKind, type Rules,
} from "./rummy.js";

/**
 * The rummy bot's brain: pure functions from what a seat sees to what it does this turn.
 *
 * It searches every way to split its hand into sets and runs (cards are compared by key = c % 52,
 * so both decks' copies of a card are the same to it), opens as soon as it can, adds what fits on
 * the table, takes the discard only when it can lay it down right away, and keeps the cards that
 * may still make melds. When it could go out with a plain card, a hard bot that feels safe holds
 * one card back for a turn or two, hoping to draw a joker and go out with it (penalties doubled).
 */
export type BotLevel = "easy" | "normal" | "hard";
export type TableMeld = { id: number; owner: string; kind: MeldKind; cards: number[] };

export type BotView = {
  level: BotLevel;
  me: string; // its seat (whose melds are its own)
  partner: string | null; // 2 vs 2: its partner (his melds count as its own)
  partnerOpened: boolean; // 2 vs 2: its partner opened, it hasn't: it lays under the team rules, no points
  rules: Rules;
  hand: number[];
  opened: boolean;
  threshold: number;
  melds: TableMeld[];
  taken: number | null; // the discard it just took: it must go down with its cards this turn
  canWait: boolean; // hard bots only: nobody is close to going out and jokers are still out there
  nextOpened: boolean; // the next player could add the card it throws to a meld on the table
};

export type BotPlan = {
  swaps: { meldId: number; cards: number[] }[];
  lay: number[][];
  adds: { meldId: number; cards: number[] }[];
  discard: number;
  finish: boolean; // the discard is its last card
  waiting: boolean; // could have gone out, holds a card back for a joker finish
};

const key = (c: number) => c % 52;
const JOKERS = [104, 105, 106, 107];
const cardPoints = (c: number) => (isJoker(c) ? 0 : rankOf(c) === 1 ? 11 : Math.min(rankOf(c), 10));

/** A meld the hand can make (allowed by the table's rules): real cards by key, plus jokers. */
type Cand = { keys: number[]; jokers: number; meld: Meld };
type Combo = { cands: Cand[]; used: number; jokers: number };

function candidates(counts: number[], jokers: number, rules: Rules): Cand[] {
  const out: Cand[] = [];
  const add = (keys: number[], j: number) => {
    const meld = meldOf([...keys, ...JOKERS.slice(0, j)]);
    if (meld && !layError(meld, rules)) out.push({ keys, jokers: j, meld });
  };
  for (let r = 0; r < 13; r++) {
    const suits = [0, 1, 2, 3].filter((s) => counts[s * 13 + r] > 0);
    for (let mask = 1; mask < 1 << suits.length; mask++) {
      const keys = suits.filter((_, i) => mask & (1 << i)).map((s) => s * 13 + r);
      if (keys.length < 2) continue;
      for (let j = Math.max(0, 3 - keys.length); j <= Math.min(jokers, 4 - keys.length); j++) add(keys, j);
    }
  }
  for (let s = 0; s < 4; s++) {
    const keyOf = (v: number) => s * 13 + ((v - 1) % 13); // v: 1–14, 14 is the high ace
    const has = (v: number) => counts[keyOf(v)] > 0;
    for (let a = 1; a <= 13; a++) {
      if (!has(a)) continue;
      for (let b = a + 1; b <= (a === 1 ? 13 : 14); b++) {
        if (!has(b)) continue;
        const values = [];
        for (let v = a; v <= b; v++) if (has(v)) values.push(v);
        const len = b - a + 1;
        const j = len - values.length + Math.max(0, 3 - len);
        if (j <= jokers) add(values.map(keyOf), j);
      }
    }
  }
  // Big melds first: the search meets good splits early (it gives up after a while).
  return out.sort((x, y) => y.keys.length + y.jokers - (x.keys.length + x.jokers) || y.meld.points - x.meld.points);
}

/** Every way to put candidates together without using a card twice; [better] picks the best. */
function bestCombo(
  hand: number[],
  rules: Rules,
  better: (a: Combo, b: Combo) => boolean,
  valid: (c: Combo) => boolean,
): Combo | null {
  const counts = new Array(52).fill(0);
  for (const c of hand) if (!isJoker(c)) counts[key(c)]++;
  const jokers = hand.filter(isJoker).length;
  const cands = candidates(counts, jokers, rules);
  let best: Combo | null = null;
  let nodes = 0;
  const chosen: Cand[] = [];
  const visit = (start: number, usedJokers: number) => {
    if (++nodes > 30_000) return; // ponytail: capped search, plenty for 15 cards
    const combo: Combo = {
      cands: [...chosen],
      used: chosen.reduce((n, c) => n + c.keys.length + c.jokers, 0),
      jokers: usedJokers,
    };
    if (valid(combo) && (!best || better(combo, best))) best = combo;
    for (let i = start; i < cands.length; i++) {
      const c = cands[i];
      if (c.jokers > jokers - usedJokers || c.keys.some((k) => counts[k] === 0)) continue;
      for (const k of c.keys) counts[k]--;
      chosen.push(c);
      visit(i + 1, usedJokers + c.jokers);
      chosen.pop();
      for (const k of c.keys) counts[k]++;
    }
  };
  visit(0, 0);
  return best;
}

/** Turns a combo's keys into real cards from [pool] (removed from it); the taken card goes first. */
function cardsOf(combo: Combo, pool: number[], taken: number | null): number[][] {
  const take = (match: (c: number) => boolean) => {
    const at = pool.findIndex((c) => c === taken && match(c));
    const i = at >= 0 ? at : pool.findIndex(match);
    return pool.splice(i, 1)[0];
  };
  return combo.cands.map((cand) => [
    ...cand.keys.map((k) => take((c) => !isJoker(c) && key(c) === k)),
    ...Array.from({ length: cand.jokers }, () => take(isJoker)),
  ]);
}

/** Greedy: each card of [pool] that fits a meld on the table goes there (jokers only if [jokersToo]). */
function addsFor(pool: number[], table: TableMeld[], keep: number, jokersToo: boolean, view: BotView) {
  const adds: { meldId: number; cards: number[] }[] = [];
  const fits = (m: TableMeld, card: number) => {
    if (!view.rules.addToOthers && m.owner !== view.me && m.owner !== view.partner) return false;
    const grown = meldOf([...m.cards, card]);
    return grown?.kind === m.kind && !(view.rules.oneJoker && grown.cards.filter(isJoker).length > 1);
  };
  for (const card of [...pool].sort((a, b) => Number(isJoker(a)) - Number(isJoker(b)))) {
    if (pool.length <= keep) break;
    if (isJoker(card) && !jokersToo) continue;
    const meld = table.find((m) => fits(m, card));
    if (!meld) continue;
    meld.cards = meldOf([...meld.cards, card])!.cards;
    pool.splice(pool.indexOf(card), 1);
    adds.push({ meldId: meld.id, cards: [card] });
  }
  return adds;
}

const usesTaken = (taken: number | null, cards: number[]) =>
  taken === null || cards.some((c) => c === taken || (!isJoker(c) && !isJoker(taken) && key(c) === key(taken)));

/** What the bot does once it has drawn (or taken) its card. Null: no legal plan that uses the taken card. */
export function planTurn(view: BotView): BotPlan | null {
  const hard = view.level === "hard", easy = view.level === "easy";
  const table: TableMeld[] = view.melds.map((m) => ({ ...m, cards: [...m.cards] }));
  let hand = [...view.hand];
  const swaps: BotPlan["swaps"] = [];
  // Real cards from the hand take the jokers' places on the table: free jokers.
  if ((view.opened || view.partnerOpened) && !easy && view.taken === null && view.rules.jokerSwap) {
    for (const meld of table) {
      const j = meld.cards.findIndex(isJoker);
      if (j < 0) continue;
      if (meld.kind === "set") {
        // A set's joker takes every missing card (9 9 joker: the two other 9s).
        const real = meld.cards.filter((c) => !isJoker(c));
        const missing = [0, 1, 2, 3].filter((suit) => !real.some((c) => suitOf(c) === suit));
        const picks = missing.map((suit) => hand.find((c) => !isJoker(c) && rankOf(c) === rankOf(real[0]) && suitOf(c) === suit));
        if (picks.some((c) => c === undefined)) continue;
        for (const c of picks) hand.splice(hand.indexOf(c!), 1);
        hand.push(meld.cards[j]);
        meld.cards = [...real, ...(picks as number[])];
        swaps.push({ meldId: meld.id, cards: picks as number[] });
      } else {
        const card = hand.find((c) => jokerFits(meld, j, c));
        if (card === undefined) continue;
        hand.splice(hand.indexOf(card), 1, meld.cards[j]);
        meld.cards[j] = card;
        swaps.push({ meldId: meld.id, cards: [card] });
      }
    }
  }
  // Opening: the table's rules (points, a real run), and maybe the taken card in it.
  const opens = (c: Combo) =>
    view.opened ||
    (view.partnerOpened && (c.used === 0 || !teamLayError(c.cands.map((x) => x.meld), view.rules))) ||
    (!openingError(c.cands.map((x) => x.meld), view.threshold, view.rules) &&
      (!view.rules.openWithDiscard || (view.taken !== null && usesTaken(view.taken, comboCards(c, view.taken)))));
  const moreCards = (a: Combo, b: Combo) => a.used > b.used || (a.used === b.used && a.jokers < b.jokers);

  // Going out: everything but one card goes down. A joker as the last card doubles the penalties.
  const lastCards = [...new Set(hand)].sort((a, b) => Number(isJoker(b)) - Number(isJoker(a)) || cardPoints(b) - cardPoints(a));
  for (const last of lastCards) {
    const rest = [...hand];
    rest.splice(rest.indexOf(last), 1);
    const combo = bestCombo(rest, view.rules, moreCards, opens);
    if (!combo) continue;
    const pool = [...rest];
    const lay = cardsOf(combo, pool, view.taken);
    const tableAfter = table.map((m) => ({ ...m, cards: [...m.cards] }));
    const adds = combo.used > 0 || view.opened || view.partnerOpened ? addsFor(pool, tableAfter, 0, true, view) : [];
    if (pool.length > 0) continue;
    const down = [...lay.flat(), ...adds.flatMap((a) => a.cards)];
    if (!usesTaken(view.taken, down) && !(last === view.taken && isJoker(last))) continue;
    // Hold a card back for a joker finish when it's safe: the last single add stays in the hand.
    if (hard && view.canWait && !isJoker(last) && adds.length > 0 && !hand.some(isJoker)) {
      const held = adds.pop()!;
      if (usesTaken(view.taken, [...lay.flat(), ...adds.flatMap((a) => a.cards)])) {
        return { swaps, lay, adds, discard: last, finish: false, waiting: true };
      }
      adds.push(held);
    }
    return { swaps, lay, adds, discard: last, finish: true, waiting: false };
  }

  // Not out yet: lay what it can (opening needs the threshold without jokers), keep one card to throw.
  const keepOne = (c: Combo) => opens(c) && c.used <= hand.length - 1 && usesTaken(view.taken, comboCards(c, view.taken));
  const combo = easy && !view.opened
    ? bestCombo(hand, view.rules, moreCards, (c) => keepOne(c) && c.cands.length <= 3)
    : bestCombo(hand, view.rules, moreCards, keepOne);
  const pool = [...hand];
  const lay = combo && combo.used > 0 ? cardsOf(combo, pool, view.taken) : [];
  const opened = view.opened || view.partnerOpened || lay.length > 0;
  const adds = opened && !easy ? addsFor(pool, table, 1, false, view) : [];
  if (!usesTaken(view.taken, [...lay.flat(), ...adds.flatMap((a) => a.cards)])) {
    // The taken card fits a table meld: add it on its own.
    const meld =
      opened && view.taken !== null
        ? table.find(
            (m) =>
              (view.rules.addToOthers || m.owner === view.me || m.owner === view.partner) &&
              meldOf([...m.cards, view.taken!])?.kind === m.kind,
          )
        : undefined;
    if (!meld || pool.length < 2) return null;
    pool.splice(pool.indexOf(view.taken!), 1);
    adds.push({ meldId: meld.id, cards: [view.taken!] });
  }
  return { swaps, lay, adds, discard: chooseDiscard(pool, view, opened, table), finish: pool.length === 1, waiting: false };
}

/** Representative cards of a combo (keys as first-deck cards, its jokers as the taken one), for the taken-card rule. */
function comboCards(c: Combo, taken: number | null): number[] {
  const joker = taken !== null && isJoker(taken) ? taken : 104;
  return c.cands.flatMap((cand) => [...cand.keys, ...Array(cand.jokers).fill(joker)]);
}

/** The card it needs least: no pair, no neighbour; when opened the heaviest, else the lightest. */
function chooseDiscard(pool: number[], view: BotView, opened: boolean, table: TableMeld[]): number {
  const real = pool.filter((c) => !isJoker(c));
  if (real.length === 0) return pool[0];
  if (view.level === "easy") return real[Math.floor(Math.random() * real.length)];
  const keep = (c: number) => {
    let score = 0;
    for (const o of real) {
      if (o === c) continue;
      if (rankOf(o) === rankOf(c) && suitOf(o) !== suitOf(c)) score += 2;
      if (suitOf(o) === suitOf(c)) {
        const d = Math.abs(rankOf(o) - rankOf(c));
        if (d === 1 || d === 12) score += 2;
        else if (d === 2 || d === 11) score += 1;
      }
    }
    // Don't feed the next player a card he can lay on the table.
    if (view.level === "hard" && view.nextOpened && table.some((m) => meldOf([...m.cards, c])?.kind === m.kind)) score += 3;
    return score;
  };
  return real.reduce((best, c) => {
    const a = keep(c), b = keep(best);
    if (a !== b) return a < b ? c : best;
    return (opened ? cardPoints(c) > cardPoints(best) : cardPoints(c) < cardPoints(best)) ? c : best;
  });
}

/** Should it take the discard? Only when the turn's plan can lay it down. */
export function wantsDiscard(view: BotView, top: number): boolean {
  if (view.level === "easy") return false;
  if (view.rules.noDiscardOnLast && view.hand.length === 1) return false;
  return planTurn({ ...view, hand: [...view.hand, top], taken: top }) !== null;
}
