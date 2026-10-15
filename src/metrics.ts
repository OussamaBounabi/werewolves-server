import { loadDay, saveDay, type DayStats } from "./accounts.js";
import { dayKey } from "./missions.js";
import { onlineCount } from "./presence.js";

/**
 * The app's numbers day by day for the admin app (daily_stats, one row a day, Algeria time): the games started in
 * each game, who opened the app, and how many were online every ten minutes. Kept here, written every ten minutes
 * and when the day turns; today's row is read back at start, so a restart loses ten minutes at most.
 */
const SAMPLE_MS = 10 * 60_000;
let today: DayStats = blank(dayKey());

function blank(key: string): DayStats {
  return { day: key.slice(2), games: {}, active: new Set(), online: [], peak: 0 };
}

/** Today's numbers (a new day starts a new row: the last one is written first). */
function current(): DayStats {
  const key = dayKey();
  if (today.day !== key.slice(2)) {
    saveDay(today).catch((e) => console.error("saving the day's numbers failed", e));
    today = blank(key);
  }
  return today;
}

/** A game started in [game] (werewolf, ludo…). */
export function gameStarted(game: string) {
  const d = current();
  d.games[game] = (d.games[game] ?? 0) + 1;
}

/** [uid] opened the app: one of today's active players. */
export function seen(uid: string) {
  const d = current();
  d.active.add(uid);
  d.peak = Math.max(d.peak, onlineCount());
}

/** Today's numbers as they are now, for the admin app. */
export function todayNow() {
  const d = current();
  return { day: d.day, games: { ...d.games }, active: d.active.size, online: [...d.online], peak: Math.max(d.peak, onlineCount()) };
}

/** Every ten minutes: how many are online, and today's row written. */
function sample() {
  const d = current();
  const now = new Date(Date.now() + 60 * 60_000); // Algeria time
  const count = onlineCount();
  d.online.push([now.getUTCHours() * 60 + now.getUTCMinutes(), count]);
  d.peak = Math.max(d.peak, count);
  saveDay(d).catch((e) => console.error("saving the day's numbers failed", e));
}

/** At start: today's row back (what was counted before a restart), then a sample every ten minutes. */
export async function startMetrics() {
  const saved: DayStats | null = await loadDay(today.day).catch((): null => null);
  if (saved && saved.day === today.day) {
    for (const [game, n] of Object.entries(saved.games)) today.games[game] = (today.games[game] ?? 0) + Number(n);
    for (const uid of saved.active) today.active.add(uid);
    today.online = [...saved.online, ...today.online];
    today.peak = Math.max(today.peak, saved.peak);
  }
  setInterval(sample, SAMPLE_MS).unref();
}
