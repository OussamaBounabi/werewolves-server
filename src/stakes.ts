import { currentPlans, db, forPlayer, maybe } from "./accounts.js";
import { playerLevel } from "./clans.js";
import type { StakePlan } from "./plans.js";

/**
 * Playing for coins (Rummy, Domino, Ludo, Billiard, Chess & Checkers, Guess Who, Mystery Item; never Werewolf,
 * Imposter or Mimic Party). The host picks one of the admin's levels; each player puts that many coins in the pot when
 * the game starts, and the house keeps its cut of what's paid out.
 * - Winners (1 vs 1, 2 vs 2, everyone for himself): the winners share the pot. A draw: each gets his own back, less
 *   the cut.
 * - A cup: 4 players, 70% / 30% to the champion and the runner-up; more, 60% / 30% / 10%, the two semi-final losers
 *   sharing the third place's.
 * - Whoever leaves the game loses his stake (his seat may play on and even win: the pot then goes to those still at
 *   the table).
 */
export const DEFAULT_STAKES: StakePlan = {
  cut: 10,
  levels: [
    { amount: 100, minLevel: 1 },
    { amount: 500, minLevel: 5 },
    { amount: 1000, minLevel: 10 },
    { amount: 5000, minLevel: 20 },
  ],
};
export const stakePlan = () => currentPlans().stakes ?? DEFAULT_STAKES;

/**
 * What each player gets from a pot. [paid]: each one's coins in it; [present]: those still at the table; [places]:
 * the winners ([[winners]]), a cup's places ([[champion], [runner-up], [semi-final losers]]), or none (a draw).
 */
export function share(paid: Map<string, number>, present: Set<string>, places: string[][], cut: number, cup = false) {
  const keep = (n: number) => Math.floor((n * (100 - cut)) / 100);
  const pot = [...paid.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, number>();
  const add = (id: string, n: number) => n > 0 && out.set(id, (out.get(id) ?? 0) + n);
  if (places.length === 0) {
    for (const [id, n] of paid) if (present.has(id)) add(id, keep(n));
    return out;
  }
  if (!cup) {
    const winners = places[0].filter((id) => present.has(id));
    const paidOut = winners.length ? winners : [...present]; // the winners left: those still here
    for (const id of paidOut) add(id, Math.floor(keep(pot) / paidOut.length));
    return out;
  }
  const shares = paid.size <= 4 ? [70, 30] : [60, 30, 10];
  shares.forEach((pct, i) => {
    const group = (places[i] ?? []).filter((id) => present.has(id)); // (a place whose player left: the house's)
    for (const id of group) add(id, Math.floor((keep(pot) * pct) / 100 / group.length));
  });
  return out;
}

/** Where the coins come from and go to (the tests use their own). */
export type Wallet = {
  /** Takes [coins] from [id] if he has them and his level is [minLevel] or more: "ok", "stake_coins" or "stake_level". */
  take(id: string, coins: number, minLevel: number): Promise<string>;
  give(id: string, coins: number): Promise<void>;
  /** One staked game, for the admin app. */
  log(row: { game: string; room: string; amount: number; pot: number; cut: number; result: string; players: unknown }): Promise<void>;
};

export const pocketWallet: Wallet = {
  take: (uid, coins, minLevel) =>
    forPlayer(uid, async () => {
      const client = await db();
      const user = await maybe(client.collection("users").getOne(uid, { fields: "coins,xp" }));
      if (!user || (Number(user.coins) || 0) < coins) return "stake_coins";
      if (playerLevel(Number(user.xp) || 0) < minLevel) return "stake_level";
      // In a batch, "coins-" can't lose a grant made at the same moment; coins can't go below 0 either.
      const batch = client.createBatch();
      batch.collection("users").update(uid, { "coins-": coins });
      await batch.send();
      return "ok";
    }),
  give: (uid, coins) =>
    forPlayer(uid, async () => {
      const batch = (await db()).createBatch();
      batch.collection("users").update(uid, { "coins+": coins });
      await batch.send();
    }),
  log: async (row) => void (await (await db()).collection("stake_games").create(row)),
};

/** The admin app's view: the last staked games (newest first) and what the house kept from them. */
export async function stakeLedger(limit = 100) {
  const rows = await (await db()).collection("stake_games").getList(1, limit, { sort: "-created" });
  const games = rows.items.map((r) => ({
    game: r.game, room: r.room, amount: r.amount, pot: r.pot, cut: r.cut, result: r.result, players: r.players, at: r.created,
  }));
  const paidOut = (g: { players: unknown }) =>
    (Array.isArray(g.players) ? g.players : []).reduce((sum: number, p: any) => sum + (Number(p?.got) || 0), 0);
  const house = games.reduce((sum, g) => sum + (Number(g.pot) || 0) - paidOut(g), 0);
  return { games, total: rows.totalItems, house };
}
