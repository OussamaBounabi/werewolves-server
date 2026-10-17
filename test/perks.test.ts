import assert from "assert";
import type { Account } from "../src/accounts.js";
import { RoomLooks } from "../src/rooms/perks.js";

const account = (uid: string, vipPro: boolean, roomLook: unknown = null): Account =>
  ({ uid, name: uid, avatar: 101, frame: 0, vip: vipPro, vipPro, roleCardDay: "", roomLook });

describe("a VIP Pro host's room look", () => {
  const silent = console.warn;
  before(() => (console.warn = () => {})); // (no database here: saving his look fails quietly)
  after(() => (console.warn = silent));

  it("is his saved one from the moment he hosts, follows the host, and is never anyone else's", () => {
    const looks = new RoomLooks();
    looks.join("pro", account("u1", true, { name: "  Les   Loups ", style: "blue" }));
    looks.join("plain", account("u2", false, { name: "Mine", style: "red" }));
    looks.join("guest", null);
    assert.deepStrictEqual(looks.of("pro"), { name: "Les Loups", style: "blue" }); // (checked: spaces, styles)
    assert.deepStrictEqual(looks.of("plain"), { name: "", style: "" }); // not VIP Pro: the usual card
    assert.strictEqual(looks.set("plain", { name: "x", style: "red" }), false);
    assert.strictEqual(looks.set("pro", { name: "Night", style: "nope" }), true);
    assert.deepStrictEqual(looks.of("pro"), { name: "Night", style: "" });
    assert.deepStrictEqual(looks.of("guest"), { name: "", style: "" });
  });
});
