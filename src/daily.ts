import { dayKey } from "./missions.js";

/**
 * The daily reward and the lucky wheel (the home's panels). The daily reward: a week of seven gifts, one a day; a
 * missed day starts the week again, and after the seventh comes the first. The wheel: one free spin a day (two for a
 * VIP), then WHEEL_PRICE diamonds a spin; its eight prizes in the app's order, the big ones rarer.
 */

export type Gift = { coins: number; diamonds: number };

export const DAILY_REWARDS: Gift[] = [
  { coins: 200, diamonds: 0 },
  { coins: 300, diamonds: 0 },
  { coins: 0, diamonds: 5 },
  { coins: 500, diamonds: 0 },
  { coins: 0, diamonds: 10 },
  { coins: 800, diamonds: 0 },
  { coins: 0, diamonds: 50 }, // the chest
];

/** A player's daily reward: the day of the seven he last took, when ("d-2026-10-29"), and days in a row. */
export type Daily = { day?: number; at?: string; streak?: number };

const DAY_MS = 86_400_000;

/** The day of the seven he may take today (1–7), or null: today's is taken. */
export function dailyNext(daily: Daily | null | undefined, now = Date.now()): number | null {
  if (daily?.at === dayKey(now)) return null;
  const onTime = daily?.at === dayKey(now - DAY_MS) && Number(daily.day) >= 1;
  return onTime ? (Number(daily!.day) % 7) + 1 : 1;
}

/** After taking today's: the day taken, today, and his days in a row. */
export function dailyTaken(daily: Daily | null | undefined, now = Date.now()): Required<Daily> {
  const day = dailyNext(daily, now)!;
  const onTime = daily?.at === dayKey(now - DAY_MS);
  return { day, at: dayKey(now), streak: onTime ? (Number(daily?.streak) || 0) + 1 : 1 };
}

export type Prize =
  | { kind: "coins" | "diamonds"; amount: number; weight: number }
  | { kind: "boost"; amount: number; weight: number } // ×XP for BOOST_MS
  | { kind: "avatar" | "frame"; id: number; weight: number };

/** In the app's order around the wheel (LuckyWheelSheet's prizes). Weights out of 100. */
export const WHEEL: Prize[] = [
  { kind: "coins", amount: 100, weight: 30 },
  { kind: "diamonds", amount: 5, weight: 14 },
  { kind: "coins", amount: 500, weight: 22 },
  { kind: "boost", amount: 2, weight: 12 },
  { kind: "coins", amount: 1000, weight: 12 },
  { kind: "diamonds", amount: 20, weight: 5 },
  { kind: "frame", id: 1, weight: 3 },
  { kind: "avatar", id: 404, weight: 2 },
];

export const WHEEL_PRICE = 10; // diamonds, once the free spins are used
export const BOOST_MS = 60 * 60_000; // the wheel's 2× XP: an hour

/** His free spins today: [wheel] is { day, used }. */
export function freeSpins(wheel: { day?: string; used?: number } | null | undefined, vip: boolean, now = Date.now()): number {
  const used = wheel?.day === dayKey(now) ? Number(wheel.used) || 0 : 0;
  return Math.max(0, (vip ? 2 : 1) - used);
}

/** A prize's place on the wheel, drawn by weight ([random] in [0, 1)); what he owns already can't come up. */
export function spin(owns: { avatars: number[]; frames: number[] }, random = Math.random()): number {
  const can = WHEEL.map((p) =>
    (p.kind === "avatar" && owns.avatars.includes(p.id)) || (p.kind === "frame" && owns.frames.includes(p.id)) ? 0 : p.weight,
  );
  let r = random * can.reduce((a, b) => a + b, 0);
  for (const [i, w] of can.entries()) if ((r -= w) < 0) return i;
  return 0;
}
