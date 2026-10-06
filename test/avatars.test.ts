import assert from "assert";

import { AVATARS, avatarIds, FRAMES, frameIds, PRICES, randomFrame, ROBOT, starterAvatar } from "../src/avatars.js";

describe("avatars", () => {
  it("sells 47 characters, 101–147, and animated ones from 201, priced by rarity; the bots' robot isn't for sale", () => {
    assert.deepStrictEqual(avatarIds, [...Array.from({ length: 47 }, (_, i) => 101 + i), 201, 202]);
    assert.strictEqual(AVATARS[ROBOT], undefined);
    assert.strictEqual(AVATARS[0], undefined); // the paw everyone has
    const count = (r: string) => avatarIds.filter((id) => AVATARS[id] === r).length;
    assert.deepStrictEqual([count("common"), count("rare"), count("epic"), count("legendary")], [8, 18, 16, 5]);
    assert.deepStrictEqual(PRICES[AVATARS[101]], { amount: 500, currency: "coins" });
    assert.deepStrictEqual(PRICES[AVATARS[147]], { amount: 120, currency: "diamonds" });
    assert.deepStrictEqual(PRICES[AVATARS[201]], { amount: 300, currency: "diamonds" });
    // A new account's free one is never animated.
    for (let i = 0; i < 300; i++) assert.notStrictEqual(AVATARS[starterAvatar()], "animated");
  });

  it("sells 4 animated frames on their own; a test client wears one of them or none", () => {
    assert.deepStrictEqual(frameIds, [1, 2, 3, 4]);
    assert.deepStrictEqual(FRAMES[1], { amount: 5000, currency: "coins" });
    for (let i = 0; i < 50; i++) assert.ok([0, 1, 2, 3, 4].includes(randomFrame()));
  });
});
