import { accountsEnabled, db, forPlayer, ledger, maybe, settings } from "./accounts.js";
import { THROWS, type Throwable } from "./plans.js";

/**
 * Throwing something at another player's avatar, in any room (an egg, a tomato, a rose, a bomb…): every throw costs
 * coins (the owner's prices, settings.throwPrices), one every 3 seconds at most. The room checks who throws at whom
 * and tells the table; this takes the coins.
 */
const GAP_MS = 3_000;

/** The coins a throw takes: "ok", or "throw_coins" (not enough). Tests: their own. */
export const throwWallet = {
  take: (uid: string, coins: number, item: string): Promise<string> =>
    forPlayer(uid, async () => {
      const client = await db();
      const user = await maybe(client.collection("users").getOne(uid, { fields: "coins" }));
      if (!user || (Number(user.coins) || 0) < coins) return "throw_coins";
      // In a batch, "coins-" can't lose a grant made at the same moment; coins can't go below 0 either.
      const batch = client.createBatch();
      batch.collection("users").update(uid, { "coins-": coins });
      ledger(batch, uid, -coins, 0, "throw", item);
      await batch.send();
      return "ok";
    }),
};

/** One room's throws: when each player last threw. */
export class Throws {
  private last = new Map<string, number>();

  /** Why [from] (his account [uid]) can't throw [item] now, or null once he has paid for it. */
  async pay(from: string, uid: string | undefined, item: unknown): Promise<string | null> {
    if (typeof item !== "string" || !(THROWS as readonly string[]).includes(item)) return "throw_unknown";
    const now = Date.now();
    if (now - (this.last.get(from) ?? 0) < GAP_MS) return "throw_wait";
    if (accountsEnabled && !uid) return "throw_guest";
    this.last.set(from, now); // (before the wait for his coins: two quick taps don't both go)
    const price = settings().throwPrices[item as Throwable] ?? 0;
    if (!accountsEnabled || price <= 0) return null; // (no accounts: the tests and local servers)
    const paid = await throwWallet.take(uid!, price, item).catch(() => "throw_coins");
    if (paid === "ok") return null;
    this.last.delete(from);
    return paid;
  }
}
