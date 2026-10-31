import assert from "assert";
import { claimable } from "../src/missions.js";
import {
  cleanEvents, cleanMissionPlan, cleanScheduled, cleanSettings, cleanStorePlan, cleanTiers, cycleIndex, eventFactor, hasBadWord, missionsNow,
  prizeFor, SETTINGS, settingsNow, storeNow,
} from "../src/plans.js";

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

  it("the owner's settings: a section changed alone, the rest kept; null puts one back; a bad section refused", () => {
    let saved = cleanSettings({ switches: { clanTags: true, other: true }, minBuild: 24.7 }, null);
    assert.deepStrictEqual(saved, { switches: { clanTags: true, chessAnalysis: false }, minBuild: 24 });
    saved = cleanSettings({ badWords: ["Bad", "x", "bad", " worse "] }, saved);
    assert.deepStrictEqual(saved.badWords, ["bad", "worse"]);
    assert.strictEqual(saved.minBuild, 24, "kept");
    const now = settingsNow(saved);
    assert.deepStrictEqual([now.switches.clanTags, now.daily, now.bots.rummy], [true, SETTINGS.daily, true]);
    assert.strictEqual(settingsNow(cleanSettings({ minBuild: null }, saved)).minBuild, 0);
    assert.throws(() => cleanSettings({ daily: [{ coins: 1 }] }, saved), /seven days/);
    assert.throws(() => cleanSettings({ clan: { price: 1, rename: 1, minLevel: 1, levels: [0, 10, 5, 20, 30, 40, 50] } }, saved), /levels/);
  });

  it("refuses an unknown wheel avatar and keeps a good wheel", () => {
    assert.throws(() => cleanSettings({ wheel: { prizes: [...SETTINGS.wheel.prizes.slice(0, 7), { kind: "avatar", id: 99999, weight: 1 }] } }, null), /eight prizes/);
    const ok = cleanSettings({ wheel: { prizes: SETTINGS.wheel.prizes, price: 0, free: 3, vipFree: 4 } }, null);
    assert.deepStrictEqual([ok.wheel?.price, ok.wheel?.free, ok.wheel?.vipFree], [1, 3, 4]);
  });

  it("events: on between their times, in their games; the biggest counts", () => {
    const events = cleanEvents([
      { kind: "coins", factor: 2, start: "2026-10-16T10:00:00Z", end: "2026-10-16T14:00:00Z" },
      { kind: "coins", factor: 3, start: "2026-10-16T10:00:00Z", end: "2026-10-16T14:00:00Z", games: ["ludo"] },
      { kind: "xp", factor: 9, start: "2026-10-17T10:00:00Z", end: "2026-10-17T12:00:00Z" },
      { kind: "coins", factor: 2, start: "2026-10-16T14:00:00Z", end: "2026-10-16T10:00:00Z" }, // ends before it starts
    ]);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[2].factor, 5, "five times at most");
    assert.deepStrictEqual(
      [eventFactor(events, "coins", "rummy", now), eventFactor(events, "coins", "ludo", now), eventFactor(events, "xp", "rummy", now)],
      [2, 3, 1],
    );
    assert.strictEqual(eventFactor(events, "coins", "rummy", Date.UTC(2026, 9, 16, 15)), 1, "over");
  });

  it("scheduled announcements: those sent stay sent", () => {
    const first = cleanScheduled([{ id: "a1", at: "2026-10-16T12:00:00Z", en: "Hi" }, { at: "x", en: "no time" }], null);
    assert.deepStrictEqual(first.map((s) => [s.id, s.sent]), [["a1", false]]);
    const again = cleanScheduled([{ id: "a1", at: "2026-10-16T12:00:00Z", en: "Hi" }], [{ ...first[0], sent: true }]);
    assert.strictEqual(again[0].sent, true);
  });

  it("finds a bad word whatever its case, accents, Arabic vowel marks or look-alike letters, inside other words too", () => {
    const words = ["idiot", "حمار"];
    assert.ok(hasBadWord("You_1D10T", words));
    assert.ok(hasBadWord("ياحِمَار", words));
    assert.ok(!hasBadWord("Idol_Fan", words));
  });
});

