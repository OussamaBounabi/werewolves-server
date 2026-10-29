/**
 * Achievements: won once each, their prize claimed from the profile (users.achievements: the ids claimed). Progress
 * comes from what the account already keeps (its stats, VIP, friends, clan), so games played before count too.
 */

type Stats = Record<string, any>;

/** What progress is read from: the account's stats, VIP now, its friends, its clan. */
export type Progress = { stats: Stats | null | undefined; vip: boolean; friends: number; clan: boolean };

export type Achievement = { id: string; goal: number; coins: number; diamonds: number; value: (p: Progress) => number };

const n = (v: unknown) => Number(v) || 0;

/** In the app's order (the profile's medals). */
export const ACHIEVEMENTS: Achievement[] = [
  { id: "firstWin", goal: 1, coins: 200, diamonds: 0, value: (p) => n(p.stats?.wins) },
  { id: "games100", goal: 100, coins: 1000, diamonds: 0, value: (p) => n(p.stats?.games) },
  { id: "wolfHunter", goal: 25, coins: 0, diamonds: 10, value: (p) => n(p.stats?.villageWins) }, // Werewolf, village side
  { id: "billiardAce", goal: 20, coins: 0, diamonds: 10, value: (p) => n(p.stats?.byGame?.billiard?.wins) },
  { id: "clan", goal: 1, coins: 300, diamonds: 0, value: (p) => (p.clan ? 1 : 0) },
  { id: "vip", goal: 1, coins: 500, diamonds: 0, value: (p) => (p.vip ? 1 : 0) },
  { id: "nightOwl", goal: 10, coins: 500, diamonds: 0, value: (p) => n(p.stats?.nightGames) }, // 00:00–05:00 in Algiers
  { id: "social", goal: 20, coins: 0, diamonds: 20, value: (p) => p.friends },
];

/** A game finished at [now] is a night game: between midnight and 5 in the morning in Algeria (UTC+1). */
export const atNight = (now: number) => (new Date(now).getUTCHours() + 1) % 24 < 5;

/** Achievement [id] if [p] reached its goal; null if it's unknown or not reached yet. */
export function reached(id: string, p: Progress): Achievement | null {
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  return a && a.value(p) >= a.goal ? a : null;
}
