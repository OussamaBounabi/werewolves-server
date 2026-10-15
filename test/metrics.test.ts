import assert from "assert";

import { gameStarted, seen, todayNow } from "../src/metrics.js";

describe("the day's numbers (the admin app's)", () => {
  it("count the games started in each game, and each player who opened the app once", () => {
    const before = todayNow();
    gameStarted("ludo");
    gameStarted("ludo");
    gameStarted("werewolf");
    seen("aya");
    seen("aya");
    seen("bilal");
    const now = todayNow();
    assert.strictEqual(now.games.ludo, (before.games.ludo ?? 0) + 2);
    assert.strictEqual(now.games.werewolf, (before.games.werewolf ?? 0) + 1);
    assert.strictEqual(now.active, before.active + 2);
  });
});
