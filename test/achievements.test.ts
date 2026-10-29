import assert from "assert";
import { ACHIEVEMENTS, atNight, reached } from "../src/achievements.js";
import { addResult } from "../src/accounts.js";

const none = { stats: {}, vip: false, friends: 0, clan: false };

describe("achievements", () => {
  it("each one from what the account keeps: wins, games, village wins, billiard wins, clan, VIP, night games, friends", () => {
    assert.strictEqual(ACHIEVEMENTS.length, 8);
    for (const a of ACHIEVEMENTS) assert.strictEqual(reached(a.id, none), null, a.id);
    const stats = { wins: 1, games: 100, villageWins: 25, byGame: { billiard: { wins: 20 } }, nightGames: 10 };
    const all = { stats, vip: true, friends: 20, clan: true };
    for (const a of ACHIEVEMENTS) assert.ok(reached(a.id, all), a.id);
    assert.strictEqual(reached("games100", { ...all, stats: { ...stats, games: 99 } }), null);
    assert.strictEqual(reached("social", { ...all, friends: 19 }), null);
    assert.strictEqual(reached("nope", all), null);
    assert.deepStrictEqual([reached("wolfHunter", all)!.coins, reached("wolfHunter", all)!.diamonds], [0, 10]);
  });

  it("night games: from midnight to 5 in Algiers, counted in the stats", () => {
    assert.strictEqual(atNight(Date.UTC(2026, 9, 29, 23, 30)), true); // 00:30 there
    assert.strictEqual(atNight(Date.UTC(2026, 9, 29, 3, 59)), true); // 04:59
    assert.strictEqual(atNight(Date.UTC(2026, 9, 29, 4, 0)), false); // 05:00
    assert.strictEqual(atNight(Date.UTC(2026, 9, 29, 22, 59)), false); // 23:59
    const game = { uid: "u", won: true, minutes: 5, name: "A", avatar: 0, frame: 0 };
    const night = addResult({}, game, 15, Date.UTC(2026, 9, 29, 0, 0));
    assert.strictEqual(addResult(night, game, 15, Date.UTC(2026, 9, 29, 12, 0)).nightGames, 1);
  });
});
