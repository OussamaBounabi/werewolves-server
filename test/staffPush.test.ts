import assert from "node:assert";
import { hearing } from "../src/staffPush.js";

describe("the staff's notifications", () => {
  it("the owner hears everything; a moderator reports and support; a removed moderator nothing", () => {
    const phones = {
      boss: { email: "Boss@Mail.com", tokens: ["b1"] },
      mod: { email: "mod@mail.com", tokens: ["m1", "m2"] },
      gone: { email: "gone@mail.com", tokens: ["g1"] },
    };
    const owners = new Set(["boss@mail.com"]), moderators = new Set(["mod"]);
    assert.deepStrictEqual(hearing(phones, "reports", owners, moderators), ["b1", "m1", "m2"]);
    assert.deepStrictEqual(hearing(phones, "support", owners, moderators), ["b1", "m1", "m2"]);
    assert.deepStrictEqual(hearing(phones, "cheats", owners, moderators), ["b1"]);
    assert.deepStrictEqual(hearing(phones, "crashes", owners, moderators), ["b1"]);
  });
});
