import assert from "assert";
import { chestFor, clanLevel, clanSeats, cleanLook, playerLevel } from "../src/clans.js";

const look = { name: "Night Wolves", tag: "nw", motto: "We play every night", shape: "shield", color: 0, join: "request", minLevel: 5 };

describe("clans", () => {
  it("levels from the clan's XP, 20 seats and 5 more each level up to 50", () => {
    assert.deepStrictEqual([0, 4999, 5000, 15000, 104_999, 105_000, 1e9].map(clanLevel), [1, 1, 2, 3, 6, 7, 7]);
    assert.deepStrictEqual([0, 5000, 105_000].map(clanSeats), [20, 25, 50]);
    assert.deepStrictEqual([0, 99, 100, 1600, 1700].map(playerLevel), [1, 1, 2, 5, 5]);
  });

  it("the weekly chest by points per member: bronze 100, silver 250, gold 500; the highest only", () => {
    assert.deepStrictEqual([0, 1999, 2000, 4999, 5000, 9999, 10_000, 1e6].map((p) => chestFor(p, 20)), [-1, -1, 0, 0, 1, 1, 2, 2]);
    assert.strictEqual(chestFor(100, 1), 0);
    assert.strictEqual(chestFor(100, 0), 0); // (a clan counts at least one)
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
