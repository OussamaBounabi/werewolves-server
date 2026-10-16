/**
 * The admin app's plans: what the store sells each week, the missions of each day and week, and what the weekly
 * ranking wins. accounts.ts keeps them (PocketBase admin_config); this file says what is live now, cleans what the
 * admin sends, and holds the defaults for when nothing is planned. Periods follow missions.ts (Algeria time): a day
 * starts at midnight, a week (the store's, the missions', the ranking's) on Monday. A plan of n days or weeks goes
 * round: after the last, the first comes again.
 */
import { AVATARS, FRAMES, FREE_AVATARS, PRICES } from "./avatars.js";
import { COUNTERS, DAILY_BONUS, MISSIONS, dayKey, weekKey, type Mission } from "./missions.js";

export type Price = { amount: number; currency: "coins" | "diamonds" };

/** Role cards (play the role you picked in your next game): on show in the store, not sold yet. Diamonds. */
export const ROLE_CARDS: Record<string, number> = {
  werewolf: 25, seer: 20, witch: 20, protector: 15, hunter: 15, wildhunter: 15, detective: 15, bear: 10, redhood: 10,
  tripleface: 20,
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

export const avatarPrice = (plan: StorePlan | null, id: number): Price => plan?.prices.avatars[id] ?? PRICES[AVATARS[id]];
export const framePrice = (plan: StorePlan | null, id: number): Price => plan?.prices.frames[id] ?? FRAMES[id];
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
    proAvatars: plan?.proAvatars ?? [],
    proFrames: plan?.proFrames ?? [],
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
