/**
 * Missions and the weekly leaderboard. Periods follow Algeria time (UTC+1 all year, no daylight saving):
 * daily missions reset at midnight, weekly ones and the leaderboard on Monday at midnight.
 * Progress is counted by the game server at each game's end; rewards are claimed through it too
 * (players can't write their own coins).
 */
const DZ_OFFSET_MS = 60 * 60_000;

/** "d-2026-09-27": the current day in Algeria. */
export function dayKey(now = Date.now()) {
  return `d-${new Date(now + DZ_OFFSET_MS).toISOString().slice(0, 10)}`;
}

/** "w-2026-09-21": the Monday (Algeria time) starting the current week. */
export function weekKey(now = Date.now()) {
  const d = new Date(now + DZ_OFFSET_MS);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday));
  return `w-${monday.toISOString().slice(0, 10)}`;
}

/** When the current day / week ends (epoch ms), for the app's countdowns. */
export function periodEnds(now = Date.now()) {
  const d = new Date(now + DZ_OFFSET_MS);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - DZ_OFFSET_MS;
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const nextMonday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7 - sinceMonday) - DZ_OFFSET_MS;
  return { day: midnight, week: nextMonday };
}

/** What a finished game adds to a player's mission counters. */
export type Counters = { games: number; wins: number; wolfWins: number; villageWins: number; survived: number; minutes: number };
export type Counter = keyof Counters;

export type Mission = {
  id: string;
  period: "daily" | "weekly";
  counter: Counter;
  target: number;
  coins: number;
  xp: number;
  diamonds: number;
};

export const MISSIONS: Mission[] = [
  { id: "d_play3", period: "daily", counter: "games", target: 3, coins: 30, xp: 20, diamonds: 0 },
  { id: "d_win1", period: "daily", counter: "wins", target: 1, coins: 40, xp: 20, diamonds: 0 },
  { id: "d_survive1", period: "daily", counter: "survived", target: 1, coins: 30, xp: 15, diamonds: 0 },
  { id: "d_minutes20", period: "daily", counter: "minutes", target: 20, coins: 40, xp: 20, diamonds: 0 },
  { id: "w_play15", period: "weekly", counter: "games", target: 15, coins: 150, xp: 100, diamonds: 0 },
  { id: "w_win7", period: "weekly", counter: "wins", target: 7, coins: 200, xp: 150, diamonds: 5 },
  { id: "w_wolf3", period: "weekly", counter: "wolfWins", target: 3, coins: 150, xp: 80, diamonds: 3 },
  { id: "w_village5", period: "weekly", counter: "villageWins", target: 5, coins: 150, xp: 80, diamonds: 0 },
];

/** Claiming every daily mission unlocks this bonus (id "d_all"). */
export const DAILY_BONUS = { id: "d_all", coins: 100, xp: 50, diamonds: 0 };

/** Whether [id] can be claimed from a period's progress document (counters + claimed ids). */
export function claimable(id: string, progress: Partial<Counters> & { claimed?: Record<string, boolean> }): boolean {
  if (progress.claimed?.[id]) return false;
  if (id === DAILY_BONUS.id) {
    return MISSIONS.filter((m) => m.period === "daily").every((m) => progress.claimed?.[m.id]);
  }
  const m = MISSIONS.find((x) => x.id === id);
  return !!m && (progress[m.counter] ?? 0) >= m.target;
}
