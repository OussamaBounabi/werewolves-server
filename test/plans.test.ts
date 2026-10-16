import assert from "assert";
import { claimable } from "../src/missions.js";
import { cleanMissionPlan, cleanStorePlan, cleanTiers, cycleIndex, missionsNow, prizeFor, storeNow } from "../src/plans.js";

// Friday 16 October 2026, noon in Algiers; its week began Monday the 12th.
const now = Date.UTC(2026, 9, 16, 11);

describe("the admin's plans", () => {
  it("goes round: after the last planned week (or day) the first comes again; nothing before the start", () => {
    assert.strictEqual(cycleIndex("w-2026-10-12", "w-2026-10-12", 5, 7), 0);
    assert.strictEqual(cycleIndex("w-2026-10-12", "w-2026-11-09", 5, 7), 4);
    assert.strictEqual(cycleIndex("w-2026-10-12", "w-2026-11-16", 5, 7), 0); // week 6 = week 1
    assert.strictEqual(cycleIndex("w-2026-10-19", "w-2026-10-12", 5, 7), null); // not begun
    assert.strictEqual(cycleIndex("w-2026-10-12", "w-2026-10-12", 0, 7), null); // nothing planned
    assert.strictEqual(cycleIndex("d-2026-10-14", "d-2026-10-16", 2, 1), 0); // day 3 of 2 = day 1
  });

  it("sells the week's items at the admin's prices, the usual ones otherwise; VIP Pro's own are never sold", () => {
    const plan = cleanStorePlan({
      start: "w-2026-10-12",
      weeks: [{ avatars: [301, 501, 999, 103], frames: [1, 2], cards: ["seer", "nope"] }, { avatars: [302], frames: [], cards: [] }],
      prices: { avatars: { 301: { amount: 99, currency: "diamonds" }, 999: { amount: 1, currency: "coins" } }, cards: { seer: 7 } },
      proAvatars: [501],
      proFrames: [2],
    });
    assert.deepStrictEqual(plan.weeks[0].avatars, [301, 501]); // (999 unknown, 103 free: dropped)
    const store = storeNow(plan, now);
    assert.deepStrictEqual(store.avatars, [{ id: 301, amount: 99, currency: "diamonds" }]); // 501 is VIP Pro's
    assert.deepStrictEqual(store.frames, [{ id: 1, amount: 5000, currency: "coins" }]);
    assert.deepStrictEqual(store.cards, [{ role: "seer", diamonds: 7 }]);
    assert.deepStrictEqual([store.index, store.proAvatars, store.proFrames, store.emojisVipOnly], [0, [501], [2], false]);
    assert.deepStrictEqual(storeNow(plan, now + 7 * 86_400_000).avatars.map((a) => a.id), [302]); // next week: week 2
    // Nothing planned: everything, at the usual prices.
    const all = storeNow(null, now);
    assert.ok(all.avatars.length > 50 && !all.avatars.some((a) => a.id === 103));
    assert.strictEqual(all.cards.length, 52); // every role but the plain villager
    assert.deepStrictEqual(all.avatars.find((a) => a.id === 601), { id: 601, amount: 300, currency: "diamonds" });
  });

  it("serves the planned missions of the day and week, the usual ones otherwise; checks what the admin sends", () => {
    const plan = cleanMissionPlan({
      daysStart: "d-2026-10-16",
      days: [
        [
          { id: "a", counter: "wins", target: 2, coins: 50, xp: 10, diamonds: 1 },
          { id: "a", counter: "games", target: 1 }, // (the same id twice: the first stays)
          { id: "Bad Id", counter: "games", target: 1 },
          { id: "b", counter: "jumps", target: 1 },
        ],
      ],
      weeksStart: "w-2026-10-12",
      weeks: [[{ id: "w1", counter: "minutes", target: 0, coins: -5 }]],
      bonus: { coins: 300 },
    });
    const m = missionsNow(plan, now);
    assert.deepStrictEqual(m.daily, [{ id: "a", period: "daily", counter: "wins", target: 2, coins: 50, xp: 10, diamonds: 1 }]);
    assert.deepStrictEqual(m.weekly, [{ id: "w1", period: "weekly", counter: "minutes", target: 1, coins: 0, xp: 0, diamonds: 0 }]);
    assert.deepStrictEqual(m.bonus, { id: "d_all", coins: 300, xp: 0, diamonds: 0 });
    const missions = [...m.daily, ...m.weekly];
    assert.ok(claimable("a", { wins: 2 }, missions) && !claimable("d_win1", { wins: 2 }, missions));
    assert.ok(claimable("d_all", { claimed: { a: true } }, missions));
    assert.strictEqual(missionsNow(null, now).daily.length, 4); // nothing planned: the usual ones
  });

  it("gives each place its prize; places counted once, from 1 to 100", () => {
    const tiers = cleanTiers([
      { from: 4, to: 10, coins: 100 },
      { from: 1, to: 1, coins: 1000, diamonds: 100, vipDays: 7 },
      { from: 2, to: 3, diamonds: 50 },
      { from: 3, to: 5, coins: 1 }, // (overlaps: dropped)
      { from: 11, to: 20 }, // (no prize: dropped)
    ]);
    assert.deepStrictEqual(tiers.map((t) => [t.from, t.to]), [[1, 1], [2, 3], [4, 10]]);
    assert.strictEqual(prizeFor(tiers, 1)?.vipDays, 7);
    assert.strictEqual(prizeFor(tiers, 3)?.diamonds, 50);
    assert.strictEqual(prizeFor(tiers, 11), null);
  });
});
