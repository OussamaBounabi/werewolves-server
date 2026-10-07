import { existsSync, readFileSync } from "node:fs";

/**
 * Guess Who, football edition: the catalogue (data/guess/catalog.json, built by scripts/guess-data.ts) and
 * the rules — what a question covers, what the answers leave possible, the bots' questions, the cup's draw.
 */
export type Names = { en: string; fr: string; ar: string };
export type Player = { id: string; name: Names; pos: string; nation: string; club: string; num: number; photo: boolean };
export type Catalog = {
  version: string;
  leagues: { id: string; flag: string; name: Names }[];
  clubs: { id: string; league: string; short: string; colors: [string, string]; name: Names }[];
  nations: { id: string; flag: string; conf: string; name: Names }[];
  players: Player[];
};
export type Category = "pos" | "nation" | "club" | "num";
/** A question about the other's footballer: is his [cat] one of [items]? An item can be a whole group: a
 * confederation for nations, a league for clubs. */
export type Question = { cat: Category; items: string[] };
export type Answer = Question & { yes: boolean };
export type Match = { a: string; b: string; winner: string; rounds: number[] }; // rounds: who won each, 0 a / 1 b

export const CATEGORIES: Category[] = ["pos", "nation", "club", "num"];
export const POSITIONS = ["GK", "DEF", "MID", "ATT"];

export const catalog: Catalog = JSON.parse(readFileSync(new URL("../data/guess/catalog.json", import.meta.url), "utf8"));
// Who has his 3D portrait (data/guess/img/<id>.webp): dropped in, they show after a restart.
for (const p of catalog.players) p.photo = existsSync(new URL(`../data/guess/img/${p.id}.webp`, import.meta.url));
const byId = new Map(catalog.players.map((p) => [p.id, p]));
export const player = (id: string) => byId.get(id);

// Each category's values, and the groups a question may name instead of them.
const universe: Record<Category, Set<string>> = {
  pos: new Set(POSITIONS),
  nation: new Set(catalog.nations.map((n) => n.id)),
  club: new Set(catalog.clubs.map((c) => c.id)),
  num: new Set(Array.from({ length: 99 }, (_, i) => String(i + 1))),
};
const groupBy = <T extends { id: string }>(list: T[], key: (t: T) => string) => {
  const m = new Map<string, string[]>();
  for (const t of list) m.set(key(t), [...(m.get(key(t)) ?? []), t.id]);
  return m;
};
const groups: Record<Category, Map<string, string[]>> = {
  pos: new Map(),
  nation: groupBy(catalog.nations, (n) => n.conf),
  club: groupBy(catalog.clubs, (c) => c.league),
  num: new Map(),
};

export const valueOf = (p: Player, cat: Category) => (cat === "num" ? String(p.num) : p[cat]);

/** The values a question covers (a confederation: all its nations; a league: all its clubs). */
export function covers(q: Question): Set<string> {
  const out = new Set<string>();
  for (const item of q.items) for (const v of groups[q.cat].get(item) ?? [item]) if (universe[q.cat].has(v)) out.add(v);
  return out;
}

/** A question as a client sent it: a known category, a few known items. */
export function validQuestion(q: unknown): q is Question {
  const { cat, items } = (q ?? {}) as Partial<Question>;
  return (
    CATEGORIES.includes(cat as Category) &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= 300 &&
    items.every((i) => typeof i === "string") &&
    covers({ cat: cat as Category, items }).size > 0
  );
}

/** What [answers] still leave possible in [cat]. */
export function possible(answers: Answer[], cat: Category): Set<string> {
  let left = universe[cat];
  for (const a of answers) {
    if (a.cat !== cat) continue;
    const s = covers(a);
    left = new Set([...left].filter((v) => s.has(v) === a.yes));
  }
  return left;
}

/** [cat]'s value once the answers leave only one, else null. */
export function found(answers: Answer[], cat: Category) {
  const left = possible(answers, cat);
  return left.size === 1 ? [...left][0] : null;
}

/** The footballers the answers (and the wrong guesses) still allow. */
export function candidates(answers: Answer[], wrong: string[] = []): Player[] {
  const sets = answers.map((a) => [a, covers(a)] as const);
  return catalog.players.filter((p) => !wrong.includes(p.id) && sets.every(([a, s]) => s.has(valueOf(p, a.cat)) === a.yes));
}

const pick = <T>(list: T[], random: () => number) => list[Math.floor(random() * list.length)];
export const randomPlayer = (random = Math.random) => pick(catalog.players, random);

/**
 * A bot's move: with few footballers left, a guess now and then; otherwise a question — half the time one
 * that splits what's left in two, half the time a hunch (one value, the commoner the likelier).
 */
export function botMove(answers: Answer[], wrong: string[], random = Math.random): Question | { guess: string } {
  const left = candidates(answers, wrong);
  if (left.length === 0) return { guess: randomPlayer(random).id };
  if (left.length === 1 || (left.length <= 3 && random() < 0.5)) return { guess: pick(left, random).id };
  const open = CATEGORIES.filter((c) => c !== "num" && !found(answers, c));
  if (open.length === 0 || random() < 0.1) {
    // the number, one at a time
    const nums = possible(answers, "num");
    return { cat: "num", items: [pick(left.map((p) => String(p.num)).filter((n) => nums.has(n)), random) ?? "10"] };
  }
  const cat = pick(open, random);
  const counts = new Map<string, number>();
  for (const p of left) counts.set(valueOf(p, cat), (counts.get(valueOf(p, cat)) ?? 0) + 1);
  const values = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (random() < 0.5) {
    let r = random() * left.length;
    for (const [v, n] of values) if ((r -= n) <= 0) return { cat, items: [v] };
    return { cat, items: [values[0][0]] };
  }
  const items: string[] = [];
  let sum = 0;
  for (const [v, n] of values) {
    if (items.length && sum + n > left.length / 2) break;
    items.push(v);
    sum += n;
  }
  return { cat, items };
}

/** A cup's matches in playing order: the first round's pairs (drawn at random), then the winners'. */
export function bracket(ids: string[], random = Math.random): Match[] {
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const matches: Match[] = [];
  for (let i = 0; i < order.length; i += 2) matches.push({ a: order[i], b: order[i + 1], winner: "", rounds: [] });
  for (let n = order.length / 4; n >= 1; n /= 2) for (let i = 0; i < n; i++) matches.push({ a: "", b: "", winner: "", rounds: [] });
  return matches;
}

/** Where the winner of match [index] plays next in a cup of [size]: the match and his side; null after the final. */
export function nextSlot(size: number, index: number): { match: number; side: "a" | "b" } | null {
  let start = 0;
  for (let n = size / 2; n >= 1; start += n, n /= 2) {
    if (index >= start + n) continue;
    if (n === 1) return null;
    const k = index - start;
    return { match: start + n + Math.floor(k / 2), side: k % 2 === 0 ? "a" : "b" };
  }
  return null;
}
