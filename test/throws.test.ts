import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { cleanSettings, settingsNow } from "../src/plans.js";
import { throwLocked } from "../src/throws.js";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("throws", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await boot(appConfig)));
  after(() => colyseus.shutdown());

  it("the owner's prices: each thing from 0, the usual for the rest", () => {
    const s = cleanSettings({ throwPrices: { egg: 2, bomb: -5, knife: "x", nope: 9 } }, null);
    assert.deepStrictEqual(s.throwPrices, {
      egg: 2, tomato: 5, heart: 5, rose: 10, bomb: 0, knife: 0, slipper: 5, kiss: 5, pie: 10,
    });
  });

  it("who may throw: everyone, VIPs (VIP Pro too), or VIP Pro only (at first)", () => {
    assert.strictEqual(settingsNow(cleanSettings({}, null)).throwsFor, "pro"); // (not saved: the usual)
    assert.deepStrictEqual(["vip", "nope"].map((v) => cleanSettings({ throwsFor: v }, null).throwsFor), ["vip", "pro"]);
    const [nobody, vip, pro] = [{ vip: false, vipPro: false }, { vip: true, vipPro: false }, { vip: true, vipPro: true }];
    assert.deepStrictEqual(
      (["all", "vip", "pro"] as const).map((level) => [nobody, vip, pro, undefined].map((a) => throwLocked(level, a))),
      [
        [null, null, null, null],
        ["throw_vip", null, null, "throw_vip"],
        ["throw_pro", "throw_pro", null, "throw_pro"],
      ],
    );
  });

  it("a card table: at another seat, a thing the apps know, one every 3 seconds; everyone at the table sees it", async () => {
    const room: any = await colyseus.createRoom("ludo", {});
    const [host, guest] = [await colyseus.connectTo(room), await colyseus.connectTo(room)];
    const seen: any[] = [], errors: any[] = [];
    for (const c of [host, guest]) {
      c.onMessage("ludo", () => {});
      c.onMessage("throw", (m: any) => seen.push(m));
    }
    host.onMessage("error", (m: any) => errors.push(m.code));
    host.send("throw", { to: host.sessionId, item: "egg" }); // not at myself
    host.send("throw", { to: "nobody", item: "egg" });
    host.send("throw", { to: guest.sessionId, item: "nope" });
    host.send("throw", { to: guest.sessionId, item: "egg" });
    host.send("throw", { to: guest.sessionId, item: "bomb" }); // too soon
    await wait(300);
    const egg = { from: host.sessionId, to: guest.sessionId, item: "egg" };
    assert.deepStrictEqual(seen, [egg, egg]);
    assert.deepStrictEqual(errors, ["throw_unknown", "throw_wait"]);
  });

  it("Werewolf: the emojis' rules (the dead at the dead only, seen in the graveyard)", async () => {
    const room: any = await colyseus.createRoom("werewolf", {});
    const [a, b, c] = [await colyseus.connectTo(room), await colyseus.connectTo(room), await colyseus.connectTo(room)];
    const seen = new Map<string, any[]>();
    for (const x of [a, b, c]) x.onMessage("throw", (m: any) => seen.set(x.sessionId, [...(seen.get(x.sessionId) ?? []), m.item]));
    a.send("throw", { to: b.sessionId, item: "rose" }); // the lobby: anyone at anyone
    await wait(200);
    assert.deepStrictEqual([seen.get(a.sessionId), seen.get(c.sessionId)], [["rose"], ["rose"]]);

    room.state.phase = "day";
    room.state.players.get(a.sessionId).alive = false;
    room.state.players.get(c.sessionId).alive = false;
    seen.clear();
    room.throws.last.clear();
    a.send("throw", { to: b.sessionId, item: "egg" }); // dead at the living: no
    await wait(100);
    a.send("throw", { to: c.sessionId, item: "kiss" });
    b.send("throw", { to: c.sessionId, item: "egg" }); // living at the dead: no
    await wait(200);
    assert.deepStrictEqual([seen.get(a.sessionId), seen.get(b.sessionId), seen.get(c.sessionId)], [["kiss"], undefined, ["kiss"]]);
  });
});
