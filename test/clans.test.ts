import assert from "assert";
import { chestFor, clanLevel, clanSeats, cleanLook, playerLevel } from "../src/clans.js";
import { CLAN_ITEMS, CLAN_PACKS, CLAN_SLOTS, clanPriceOf, slotOf } from "../src/clanItems.js";
import { cleanChests } from "../src/plans.js";

const look = { name: "Night Wolves", tag: "nw", motto: "We play every night", shape: "shield", color: 0, join: "request", minLevel: 5 };

describe("clans", () => {
  it("levels from the clan's XP, 20 seats and 5 more each level up to 50", () => {
    assert.deepStrictEqual([0, 4999, 5000, 15000, 104_999, 105_000, 1e9].map((x) => clanLevel(x)), [1, 1, 2, 3, 6, 7, 7]);
    assert.deepStrictEqual([0, 5000, 105_000].map((x) => clanSeats(x)), [20, 25, 50]);
    assert.deepStrictEqual([0, 99, 100, 1600, 1700].map(playerLevel), [1, 1, 2, 5, 5]);
  });

  it("a Pro clan goes on past level 7, 5 seats each, up to 80; without Pro it stops at 50", () => {
    assert.deepStrictEqual([105_000, 139_999, 140_000, 180_000, 225_000, 275_000, 330_000, 390_000, 1e9].map((x) => clanSeats(x, true)), [50, 50, 55, 60, 65, 70, 75, 80, 80]);
    assert.deepStrictEqual([0, 390_000].map((x) => clanSeats(x, false)), [20, 50]);
    assert.strictEqual(clanLevel(390_000, true), 13);
  });

  it("the clan store: every badge but E16, five packs of known items, one item for each of a pack's places", () => {
    const count = (slot: string) => Object.keys(CLAN_ITEMS).filter((id) => slotOf(id) === slot).length;
    assert.deepStrictEqual(["fx", "shape", "tag", "badge", "row", "card"].map(count), [24, 12, 17, 15, 12, 5]);
    assert.strictEqual(CLAN_ITEMS["badge.16"], undefined);
    assert.deepStrictEqual(Object.keys(CLAN_PACKS), ["royal_gold", "aurora_neon", "inferno", "moon_wolf", "rose_royale"]);
    for (const [pack, items] of Object.entries(CLAN_PACKS)) {
      for (const id of items) {
        assert.ok(CLAN_SLOTS.includes(slotOf(id)), id);
        if (!id.endsWith(pack)) assert.ok(CLAN_ITEMS[id], id); // (only its banner, page and lounge are the pack's own)
      }
      assert.strictEqual(new Set(items.map(slotOf)).size, items.length, pack);
      assert.ok(clanPriceOf(`pack.${pack}`));
    }
    assert.strictEqual(clanPriceOf("nothing.1"), undefined);
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
