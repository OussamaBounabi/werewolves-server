import assert from "assert";

import { AVATARS, avatarIds, FRAMES, frameIds, FREE_AVATARS, PRICES, randomFrame, ROBOT } from "../src/avatars.js";

describe("avatars", () => {
  it("sells 74 characters in four rarities, priced by rarity; the robot and the retired ones aren't for sale", () => {
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    assert.deepStrictEqual(avatarIds, [...range(101, 126), ...range(301, 318), ...range(401, 418), ...range(501, 507), ...range(601, 605)]);
    assert.strictEqual(AVATARS[ROBOT], undefined);
    assert.strictEqual(AVATARS[0], undefined); // the paw everyone has
    // The first collection's epic and legendary ones, and its two animated ones: retired, their owners keep them.
    for (const id of [127, 142, 143, 147, 201, 202]) assert.strictEqual(AVATARS[id], undefined);
    const count = (r: string) => avatarIds.filter((id) => AVATARS[id] === r).length;
    assert.deepStrictEqual([count("common"), count("rare"), count("legendary"), count("mythic")], [26, 36, 7, 5]);
    assert.deepStrictEqual(PRICES[AVATARS[101]], { amount: 500, currency: "coins" });
    assert.deepStrictEqual(PRICES[AVATARS[401]], { amount: 1500, currency: "coins" });
    assert.deepStrictEqual(PRICES[AVATARS[507]], { amount: 120, currency: "diamonds" });
    assert.deepStrictEqual(PRICES[AVATARS[601]], { amount: 300, currency: "diamonds" });
    // Two of the hoodie friends are everyone's, free.
    assert.deepStrictEqual(FREE_AVATARS, [103, 104]);
    assert.ok(FREE_AVATARS.every((id) => AVATARS[id] === "common"));
  });

  it("sells 4 animated frames on their own; a test client wears one of them or none", () => {
    assert.deepStrictEqual(frameIds, [1, 2, 3, 4]);
    assert.deepStrictEqual(FRAMES[1], { amount: 5000, currency: "coins" });
    for (let i = 0; i < 50; i++) assert.ok([0, 1, 2, 3, 4].includes(randomFrame()));
  });
});
