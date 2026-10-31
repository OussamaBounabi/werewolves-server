/**
 * The admin app's plans: what the store sells each week, the missions of each day and week, and what the weekly
 * ranking wins. accounts.ts keeps them (PocketBase admin_config); this file says what is live now, cleans what the
 * admin sends, and holds the defaults for when nothing is planned. Periods follow missions.ts (Algeria time): a day
 * starts at midnight, a week (the store's, the missions', the ranking's) on Monday. A plan of n days or weeks goes
 * round: after the last, the first comes again.
 */
import { AVATARS, FRAMES, FREE_AVATARS, PRICES } from "./avatars.js";
import { COUNTERS, DAILY_BONUS, MISSIONS, dayKey, weekKey, type Mission } from "./missions.js";
import { DAILY_REWARDS, WHEEL, type Gift, type Prize } from "./daily.js";

export type Price = { amount: number; currency: "coins" | "diamonds" };

/**
 * Role cards, one for every role but the plain villager (play the role you picked in your next game): on show in the
 * store, not sold yet. Diamonds, by how much the role weighs on a game; the admin app sets any other price.
 */
export const ROLE_CARDS: Record<string, number> = {
  // the pack
  werewolf: 25, fatherwolf: 30, blackwolf: 25, bluewolf: 20, greenwolf: 25, redwolf: 25, juniorwolf: 20, seerwolf: 30,
  bigbadwolf: 30, chameleonwolf: 25, wolfdog: 20,
  // the loners
  whitewolf: 30, alien: 30, bomber: 30, piper: 30, guitarist: 30, killer: 30,
  // the village
  seer: 20, witch: 20, protector: 15, hunter: 15, wildhunter: 15, detective: 15, bear: 10, redhood: 10, tripleface: 20,
  cupid: 15, wildchild: 15, dragon: 25, barbe: 20, dictator: 20, judge: 20, trickster: 15, fox: 15, ancient: 15,
  doubler: 20, joker: 20, raven: 15, owl: 15, idiot: 10, knight: 15, brothers: 10, cat: 15, littlegirl: 15, shepherd: 15,
  rabbit: 15, policeman: 20, mirror: 15, priest: 20, alchemist: 25, servant: 15, puppet: 15,
};

export type StoreWeek = { avatars: number[]; frames: number[]; cards: string[] };

export type StorePlan = {
  start: string; // the Monday its first week opens ("w-2026-10-19")
  weeks: StoreWeek[];
  prices: { avatars: Record<string, Price>; frames: Record<string, Price>; cards: Record<string, number> }; // else the usual
  proAvatars: number[]; // VIP Pro's own: free for a VIP Pro, shown locked to the others, never sold
  proFrames: number[];
  emojisVipOnly: boolean; // emojis for VIPs only (off until the owner says so)
};

export type MissionPlan = {
  daysStart: string; // the day its first day opens ("d-2026-10-16")
  days: Mission[][];
  weeksStart: string; // the Monday its first week opens
  weeks: Mission[][];
  bonus: { coins: number; xp: number; diamonds: number }; // for claiming every daily mission of the day
};

/** The weekly ranking's prizes: places [from]–[to] each win this. */
export type RewardTier = { from: number; to: number; coins: number; diamonds: number; vipDays: number };

/** Playing for coins: the house's cut (%) and the stakes a host may pick, each from a player level. */
export type StakePlan = { cut: number; levels: { amount: number; minLevel: number }[] };

/** The admin's stakes: a cut of 0–50%, up to 8 levels, each amount once, smallest first. */
export function cleanStakePlan(v: any): StakePlan {
  const seen = new Set<number>();
  const levels = (Array.isArray(v?.levels) ? v.levels : [])
    .map((l: any) => ({ amount: int(l?.amount, 10, 1_000_000), minLevel: int(l?.minLevel, 1, 100) }))
    .filter((l: { amount: number }) => !seen.has(l.amount) && seen.add(l.amount))
    .sort((a: { amount: number }, b: { amount: number }) => a.amount - b.amount)
    .slice(0, 8);
  return { cut: int(v?.cut, 0, 50), levels };
}

/** The weekly clan chest: bronze, silver, gold, each its points for a 20-seat clan and what each member who played wins. */
export type ChestPlan = { goal: number; coins: number; diamonds: number }[];

const DAY_MS = 86_400_000;
const keyTime = (key: string) => Date.parse(`${key.slice(2)}T00:00:00Z`); // "d-2026-10-16" / "w-2026-10-12"

/** Which of [n] planned periods is live in period [now] (a day or week key), counted from [start]; null if none yet. */
export function cycleIndex(start: string, now: string, n: number, days: number): number | null {
  const elapsed = Math.round((keyTime(now) - keyTime(start)) / (days * DAY_MS));
  return n === 0 || !Number.isFinite(elapsed) || elapsed < 0 ? null : elapsed % n;
}

// ---- the store ----

/** Avatars and frames the store can sell (not the free two, not the bots' robot). */
const sellableAvatars = () => Object.keys(AVATARS).map(Number).filter((id) => !FREE_AVATARS.includes(id));
const frameIds = () => Object.keys(FRAMES).map(Number);

// (Copies: the web layer writes an object met twice in one answer as the text "[Circular ref-N]", and every avatar of
// a rarity has the same usual price.)
export const avatarPrice = (plan: StorePlan | null, id: number): Price => ({ ...(plan?.prices.avatars[id] ?? PRICES[AVATARS[id]]) });
export const framePrice = (plan: StorePlan | null, id: number): Price => ({ ...(plan?.prices.frames[id] ?? FRAMES[id]) });
export const cardPrice = (plan: StorePlan | null, role: string) => plan?.prices.cards[role] ?? ROLE_CARDS[role];

/**
 * The store this week: what's on sale and for how much (nothing planned: everything, at the usual prices), VIP
 * Pro's own items, and whether emojis are for VIPs only. [index]: the plan's week on now (null: no plan).
 */
export function storeNow(plan: StorePlan | null, now = Date.now()) {
  const index = plan ? cycleIndex(plan.start, weekKey(now), plan.weeks.length, 7) : null;
  const week: StoreWeek =
    index === null ? { avatars: sellableAvatars(), frames: frameIds(), cards: Object.keys(ROLE_CARDS) } : plan!.weeks[index];
  const pro = new Set([...(plan?.proAvatars ?? []), ...(plan?.proFrames ?? []).map((f) => -f)]); // (frames negative)
  return {
    week: weekKey(now),
    index,
    avatars: week.avatars.filter((id) => !pro.has(id)).map((id) => ({ id, ...avatarPrice(plan, id) })),
    frames: week.frames.filter((id) => !pro.has(-id)).map((id) => ({ id, ...framePrice(plan, id) })),
    cards: week.cards.map((role) => ({ role, diamonds: cardPrice(plan, role) })),
    proAvatars: [...(plan?.proAvatars ?? [])], // (copies too: the admin's answers hold the plan as well)
    proFrames: [...(plan?.proFrames ?? [])],
    emojisVipOnly: plan?.emojisVipOnly === true,
  };
}

const int = (v: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v)) || 0));
const list = <T>(v: unknown, keep: (x: unknown) => x is T, max = 500): T[] =>
  Array.isArray(v) ? [...new Set(v.filter(keep))].slice(0, max) : [];
const isAvatar = (x: unknown): x is number => typeof x === "number" && x in AVATARS && !FREE_AVATARS.includes(x);
const isFrame = (x: unknown): x is number => typeof x === "number" && x in FRAMES;
const isCard = (x: unknown): x is string => typeof x === "string" && x in ROLE_CARDS;
const isKey = (v: unknown, kind: "d" | "w"): v is string =>
  typeof v === "string" && new RegExp(`^${kind}-\\d{4}-\\d{2}-\\d{2}$`).test(v) && Number.isFinite(keyTime(v));

/** Prices by item ({ "301": { amount, currency } }), those of known items with a currency. */
function prices(v: unknown, known: (id: number) => boolean) {
  const out: Record<string, Price> = {};
  for (const [k, p] of Object.entries((v ?? {}) as Record<string, Partial<Price>>)) {
    if (known(Number(k)) && (p?.currency === "coins" || p?.currency === "diamonds")) {
      out[k] = { amount: int(p.amount, 0, 1_000_000), currency: p.currency };
    }
  }
  return out;
}

/** What the admin app sent, checked: unknown items, bad prices and odd sizes dropped; a plan of 52 weeks at most. */
export function cleanStorePlan(v: unknown): StorePlan {
  const p = (v ?? {}) as Record<string, any>;
  return {
    start: isKey(p.start, "w") ? p.start : weekKey(),
    weeks: (Array.isArray(p.weeks) ? p.weeks : []).slice(0, 52).map((w: any) => ({
      avatars: list(w?.avatars, isAvatar),
      frames: list(w?.frames, isFrame),
      cards: list(w?.cards, isCard),
    })),
    prices: {
      avatars: prices(p.prices?.avatars, isAvatar),
      frames: prices(p.prices?.frames, isFrame),
      cards: Object.fromEntries(
        Object.entries((p.prices?.cards ?? {}) as Record<string, unknown>)
          .filter(([role]) => isCard(role))
          .map(([role, d]) => [role, int(d, 0, 100_000)]),
      ),
    },
    proAvatars: list(p.proAvatars, isAvatar),
    proFrames: list(p.proFrames, isFrame),
    emojisVipOnly: p.emojisVipOnly === true,
  };
}

// ---- missions ----

/** Today's and this week's missions (nothing planned: the usual ones), and the bonus for claiming all of today's. */
export function missionsNow(plan: MissionPlan | null, now = Date.now()) {
  const d = plan ? cycleIndex(plan.daysStart, dayKey(now), plan.days.length, 1) : null;
  const w = plan ? cycleIndex(plan.weeksStart, weekKey(now), plan.weeks.length, 7) : null;
  return {
    daily: d === null ? MISSIONS.filter((m) => m.period === "daily") : plan!.days[d],
    weekly: w === null ? MISSIONS.filter((m) => m.period === "weekly") : plan!.weeks[w],
    bonus: { ...DAILY_BONUS, ...(plan?.bonus ?? {}) },
    dayIndex: d,
    weekIndex: w,
  };
}

const MISSION_ID = /^[a-z0-9_-]{1,40}$/;

function mission(v: unknown, period: Mission["period"]): Mission | null {
  const m = (v ?? {}) as Record<string, unknown>;
  if (typeof m.id !== "string" || !MISSION_ID.test(m.id) || m.id === DAILY_BONUS.id) return null;
  if (!(COUNTERS as readonly unknown[]).includes(m.counter)) return null;
  return {
    id: m.id,
    period,
    counter: m.counter as Mission["counter"],
    target: int(m.target, 1, 100_000),
    coins: int(m.coins, 0, 1_000_000),
    xp: int(m.xp, 0, 1_000_000),
    diamonds: int(m.diamonds, 0, 100_000),
  };
}

/** The missions of each day and week, checked (ten a period at most, ids unique in it; a year of days at most). */
export function cleanMissionPlan(v: unknown): MissionPlan {
  const p = (v ?? {}) as Record<string, any>;
  const periods = (lists: unknown, period: Mission["period"], max: number) =>
    (Array.isArray(lists) ? lists : []).slice(0, max).map((ms: unknown) => {
      const seen = new Set<string>();
      return (Array.isArray(ms) ? ms : [])
        .map((m) => mission(m, period))
        .filter((m): m is Mission => !!m && !seen.has(m.id) && !!seen.add(m.id))
        .slice(0, 10);
    });
  return {
    daysStart: isKey(p.daysStart, "d") ? p.daysStart : dayKey(),
    days: periods(p.days, "daily", 366),
    weeksStart: isKey(p.weeksStart, "w") ? p.weeksStart : weekKey(),
    weeks: periods(p.weeks, "weekly", 52),
    bonus: { coins: int(p.bonus?.coins, 0, 1_000_000), xp: int(p.bonus?.xp, 0, 1_000_000), diamonds: int(p.bonus?.diamonds, 0, 100_000) },
  };
}

// ---- the weekly ranking ----

/** What place [rank] of the week wins (null: nothing). */
export const prizeFor = (tiers: RewardTier[], rank: number) => tiers.find((t) => t.from <= rank && rank <= t.to) ?? null;

/** The prizes, checked: places 1–100, in order, none counted twice. */
/** The admin's chests: three, their goals rising (a goal not above the last is raised past it). */
export function cleanChests(v: unknown): ChestPlan {
  const list = Array.isArray(v) ? v : [];
  const chests: ChestPlan = [];
  for (let i = 0; i < 3; i++) {
    const c = list[i] as any;
    const goal = Math.max(int(c?.goal, 100, 10_000_000), (chests[i - 1]?.goal ?? 0) + 1);
    chests.push({ goal, coins: int(c?.coins, 0, 1_000_000), diamonds: int(c?.diamonds, 0, 100_000) });
  }
  return chests;
}

export function cleanTiers(v: unknown): RewardTier[] {
  const tiers = (Array.isArray(v) ? v : [])
    .map((t: any) => {
      const from = int(t?.from, 1, 100);
      return {
        from,
        to: Math.max(from, int(t?.to, 1, 100)),
        coins: int(t?.coins, 0, 1_000_000),
        diamonds: int(t?.diamonds, 0, 100_000),
        vipDays: int(t?.vipDays, 0, 365),
      };
    })
    .filter((t) => t.coins + t.diamonds + t.vipDays > 0)
    .sort((a, b) => a.from - b.from);
  const kept: RewardTier[] = [];
  for (const t of tiers) if (!kept.length || t.from > kept[kept.length - 1].to) kept.push(t);
  return kept.slice(0, 20);
}

// ---- the admin app's settings, events, staff and scheduled announcements ----

/** Features the owner turns on and off without a new app (the apps read them from /api/config). */
export const SWITCHES = { clanTags: false, chessAnalysis: false };
export type SwitchId = keyof typeof SWITCHES;

/** The games whose host may add bots, each one on by default. */
export const BOT_GAMES = ["rummy", "domino", "billiard", "chess", "ludo", "guess", "mystery"] as const;

/** A word the owner added to Imposter (its category and three languages). */
export type ExtraWord = { id: string; cat: string; en: string; fr: string; ar: string };

/** What the owner sets in the admin app: anything left out is the usual (SETTINGS). */
export type Settings = {
  switches: Record<SwitchId, boolean>;
  daily: Gift[]; // the seven days' gifts
  wheel: { prizes: Prize[]; price: number; free: number; vipFree: number }; // eight prizes, in the app's order
  clan: { price: number; rename: number; minLevel: number; levels: number[] }; // levels: the XP each of the 7 starts at
  minBuild: number; // apps of an older build must update (0: any)
  badWords: string[]; // starred out of chats; refused in names
  bots: Record<string, boolean>; // the games whose host may add bots
  imposterOff: string[]; // Imposter's words taken out
  imposterAdd: ExtraWord[];
  mysteryOff: string[]; // Mystery Item's things taken out
};

export const SETTINGS: Settings = {
  switches: { ...SWITCHES },
  daily: DAILY_REWARDS,
  wheel: { prizes: WHEEL, price: 10, free: 1, vipFree: 2 },
  clan: { price: 100, rename: 50, minLevel: 5, levels: [0, 5000, 15000, 30000, 50000, 75000, 105000] },
  minBuild: 0,
  badWords: [],
  bots: Object.fromEntries(BOT_GAMES.map((g) => [g, true])),
  imposterOff: [],
  imposterAdd: [],
  mysteryOff: [],
};

/** The settings in force: the owner's, the usual for anything he left out. */
export const settingsNow = (saved: Partial<Settings> | null): Settings => ({
  ...SETTINGS,
  ...(saved ?? {}),
  switches: { ...SETTINGS.switches, ...(saved?.switches ?? {}) },
  bots: { ...SETTINGS.bots, ...(saved?.bots ?? {}) },
});

const gift = (g: any): Gift => ({ coins: int(g?.coins, 0, 1_000_000), diamonds: int(g?.diamonds, 0, 100_000) });

function prize(p: any): Prize | null {
  const weight = int(p?.weight, 0, 1000);
  if (p?.kind === "coins" || p?.kind === "diamonds") return { kind: p.kind, amount: int(p.amount, 1, 1_000_000), weight };
  if (p?.kind === "boost") return { kind: "boost", amount: int(p.amount, 2, 5), weight };
  if (p?.kind === "avatar" && isAvatar(p.id)) return { kind: "avatar", id: p.id, weight };
  if (p?.kind === "frame" && isFrame(p.id)) return { kind: "frame", id: p.id, weight };
  return null;
}

const WORD_ID = /^[a-z]+-[0-9a-z]{1,12}$/;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ids = (v: unknown, pattern: RegExp) =>
  [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && pattern.test(x)))].slice(0, 5000);

/**
 * The sections of the settings the admin app sent, checked, over [saved]: only those it holds change; null puts one
 * back to the usual. A section that doesn't check out throws.
 */
export function cleanSettings(v: any, saved: Partial<Settings> | null): Partial<Settings> {
  const out: Partial<Settings> = { ...(saved ?? {}) };
  const set = <K extends keyof Settings>(key: K, clean: (x: any) => Settings[K]) => {
    if (!v || !(key in v)) return;
    if (v[key] === null) delete out[key];
    else out[key] = clean(v[key]);
  };
  set("switches", (s) => Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, s?.[k] === true])) as Settings["switches"]);
  set("daily", (d) => {
    const days = (Array.isArray(d) ? d : []).slice(0, 7).map(gift);
    if (days.length !== 7) throw new Error("seven days");
    return days;
  });
  set("wheel", (w) => {
    const prizes = (Array.isArray(w?.prizes) ? w.prizes : []).slice(0, 8).map(prize);
    if (prizes.length !== 8 || prizes.some((p: Prize | null) => !p)) throw new Error("eight prizes");
    if (!prizes.some((p: Prize) => p.weight > 0)) throw new Error("weights");
    return { prizes, price: int(w.price, 1, 10_000), free: int(w.free, 0, 10), vipFree: int(w.vipFree, 0, 10) };
  });
  set("clan", (c) => {
    const levels = (Array.isArray(c?.levels) ? c.levels : []).slice(0, 7).map((x: unknown) => int(x, 0, 100_000_000));
    if (levels.length !== 7 || levels[0] !== 0 || levels.some((x: number, i: number) => i > 0 && x <= levels[i - 1])) {
      throw new Error("levels");
    }
    return { price: int(c.price, 0, 100_000), rename: int(c.rename, 0, 100_000), minLevel: int(c.minLevel, 1, 100), levels };
  });
  set("minBuild", (b) => int(b, 0, 100_000));
  set("badWords", (w) =>
    [...new Set((Array.isArray(w) ? w : []).map((x) => text(x, 40).toLowerCase()).filter((x) => x.length >= 2))].slice(0, 2000),
  );
  set("bots", (b) => Object.fromEntries(BOT_GAMES.map((g) => [g, b?.[g] !== false])));
  set("imposterOff", (o) => ids(o, WORD_ID));
  set("imposterAdd", (a) =>
    (Array.isArray(a) ? a : []).slice(0, 2000).flatMap((w: any) => {
      const word = { id: text(w?.id, 30), cat: text(w?.cat, 20), en: text(w?.en, 40), fr: text(w?.fr, 40), ar: text(w?.ar, 40) };
      return WORD_ID.test(word.id) && /^[a-z]+$/.test(word.cat) && word.en && word.fr && word.ar ? [word] : [];
    }),
  );
  set("mysteryOff", (o) => ids(o, /^[a-z0-9-]{1,60}$/));
  return out;
}

/**
 * One character as bad words are compared (the app's remote_config.dart does the same): lower case, no accent or
 * Arabic vowel mark, look-alikes made one (أ إ آ → ا, ى → ي, ة → ه; 0 → o, @ → a…); spaces and signs dropped.
 */
const SWAPS: Record<string, string> = {
  أ: "ا", إ: "ا", آ: "ا", ٱ: "ا", ى: "ي", ة: "ه", ؤ: "و", ئ: "ي",
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "@": "a", $: "s", "7": "t",
};
const plain = (text: string) =>
  [...text.toLowerCase().normalize("NFD")]
    .map((c) => SWAPS[c] ?? c)
    .filter((c) => /[a-z0-9؀-ۿ]/.test(c) && !/[ً-ٰٟـ]/.test(c))
    .join("");

/** Whether [text] holds one of [words] (whatever its case, accents or look-alike letters, inside other words too). */
export const hasBadWord = (text: string, words: string[]) => {
  const hay = plain(text);
  return words.some((w) => plain(w).length >= 2 && hay.includes(plain(w)));
};

/** Double coins or XP (or more) for a while: in every game, or only some. */
export type GameEvent = {
  id: string;
  title: { ar: string; en: string; fr: string };
  kind: "coins" | "xp";
  factor: number; // 2 … 5
  start: string; // ISO times
  end: string;
  games: string[]; // none: every game
};

const newKey = () => Math.random().toString(36).slice(2, 12);

export function cleanEvents(v: unknown): GameEvent[] {
  return (Array.isArray(v) ? v : []).slice(0, 100).flatMap((e: any) => {
    const start = Date.parse(e?.start), end = Date.parse(e?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (e?.kind !== "coins" && e?.kind !== "xp")) return [];
    return [{
      id: /^[a-z0-9]{1,20}$/.test(e?.id) ? e.id : newKey(),
      title: { ar: text(e?.title?.ar, 80), en: text(e?.title?.en, 80), fr: text(e?.title?.fr, 80) },
      kind: e.kind,
      factor: int(e?.factor, 2, 5),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      games: ids(e?.games, /^[a-z]{1,20}$/),
    }];
  });
}

/** The events on at [now] (ended ones are kept for the admin app's list). */
export const eventsOn = (events: GameEvent[] | null, now = Date.now()) =>
  (events ?? []).filter((e) => Date.parse(e.start) <= now && now < Date.parse(e.end));

/** How many times a game's [kind] counts now in [game]: the biggest event on for it (1: none). */
export const eventFactor = (events: GameEvent[] | null, kind: GameEvent["kind"], game: string, now = Date.now()) =>
  Math.max(1, ...eventsOn(events, now).filter((e) => e.kind === kind && (e.games.length === 0 || e.games.includes(game))).map((e) => e.factor));

/** An announcement the server sends at its time (to every phone too, with [push]). */
export type Scheduled = { id: string; at: string; ar: string; en: string; fr: string; push: boolean; sent: boolean };

export function cleanScheduled(v: unknown, saved: Scheduled[] | null): Scheduled[] {
  const sent = new Set((saved ?? []).filter((s) => s.sent).map((s) => s.id));
  return (Array.isArray(v) ? v : []).slice(0, 100).flatMap((s: any) => {
    const at = Date.parse(s?.at);
    const texts = { ar: text(s?.ar, 1000), en: text(s?.en, 1000), fr: text(s?.fr, 1000) };
    if (!Number.isFinite(at) || !(texts.ar || texts.en || texts.fr)) return [];
    const id = /^[a-z0-9]{1,20}$/.test(s?.id) ? s.id : newKey();
    return [{ id, at: new Date(at).toISOString(), ...texts, push: s?.push === true, sent: sent.has(id) }];
  });
}

/** A moderator, as the owner added him. */
export type Moderator = { uid: string; name: string; username: string; added: string };
