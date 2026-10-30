import assert from "assert";
import { chestFor, clanLevel, clanSeats, cleanLook, playerLevel } from "../src/clans.js";
import { cleanChests } from "../src/plans.js";

const look = { name: "Night Wolves", tag: "nw", motto: "We play every night", shape: "shield", color: 0, join: "request", minLevel: 5 };

describe("clans", () => {
  it("levels from the clan's XP, 20 seats and 5 more each level up to 50", () => {
    assert.deepStrictEqual([0, 4999, 5000, 15000, 104_999, 105_000, 1e9].map(clanLevel), [1, 1, 2, 3, 6, 7, 7]);
    assert.deepStrictEqual([0, 5000, 105_000].map(clanSeats), [20, 25, 50]);
    assert.deepStrictEqual([0, 99, 100, 1600, 1700].map(playerLevel), [1, 1, 2, 5, 5]);
  });

  it("the weekly chest: 10k, 20k, 40k points for 20 seats, scaled to the seats; the highest only; the admin's own", () => {
    // 20 seats: 10k, 20k, 40k; 50 seats: 2.5 times as much.
    assert.deepStrictEqual([0, 9999, 10_000, 19_999, 20_000, 39_999, 40_000, 1e6].map((p) => chestFor(p, 20)), [-1, -1, 0, 0, 1, 1, 2, 2]);
    assert.deepStrictEqual([24_999, 25_000, 50_000, 99_999, 100_000].map((p) => chestFor(p, 50)), [-1, 0, 1, 1, 2]);
    // The admin's: three, goals rising.
    const mine = cleanChests([{ goal: 500, coins: 10 }, { goal: 300, diamonds: 2 }, { goal: 2000, coins: -5 }]);
    assert.deepStrictEqual(mine.map((c) => c.goal), [500, 501, 2000]);
    assert.deepStrictEqual([mine[0].coins, mine[1].diamonds, mine[2].coins], [10, 2, 0]);
    assert.strictEqual(chestFor(1250, 50, mine), 0);
  });

  it("a clan's look: the tag in capitals, everything checked", () => {
    assert.deepStrictEqual(cleanLook({ ...look, name: "  Night   Wolves " }), { ...look, tag: "NW" });
    for (const bad of [
      { name: "NW" }, { name: "x".repeat(21) }, { tag: "N" }, { tag: "NWOLF" }, { tag: "N-W" }, { motto: "x".repeat(41) },
      { shape: "heart" }, { color: 8 }, { color: 1.5 }, { join: "maybe" }, { minLevel: 0 }, { minLevel: 51 },
    ]) {
      assert.throws(() => cleanLook({ ...look, ...bad }), /invalid/, JSON.stringify(bad));
    }
  });
});
