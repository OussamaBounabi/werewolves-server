import assert from "assert";
import type { Account } from "../src/accounts.js";
import { Kicks, listWatchers, RoomLooks, STAY_SECONDS } from "../src/rooms/perks.js";

const account = (uid: string, vipPro: boolean, roomLook: unknown = null): Account =>
  ({ uid, name: uid, avatar: 101, frame: 0, vip: vipPro, vipPro, roleCardDay: "", roleCardUsed: 0, roomLook });

describe("who is watching", () => {
  it("how many is told to all, who to a VIP Pro only, without the players or support; each account once", () => {
    const client = (id: string, a: Account | null, sent: unknown[] = []) => ({ id, auth: { account: a }, send: (_: string, m: unknown) => sent.push(m) });
    const pro: unknown[] = [], plain: unknown[] = [];
    const clients = [
      client("pro", account("u1", true), pro), client("plain", account("u2", false), plain),
      client("seen", account("u3", false)), client("support", null),
      client("seen", account("u3", false)), // (his app changed network: his old connection is still here a while)
    ];
    let ask: (c: unknown) => void = () => {};
    const room = { clients, onMessage: (_: string, fn: (c: unknown) => void) => (ask = fn) } as never;
    listWatchers(room, (c) => ["seen", "support"].includes((c as unknown as { id: string }).id));
    ask(clients[1]);
    assert.deepStrictEqual(plain, [{ count: 1 }]);
    ask(clients[0]);
    assert.deepStrictEqual(pro, [{ count: 1, list: [{ uid: "u3", name: "u3", avatar: 101, frame: 0, vip: "" }] }]);
  });
});

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

describe("kicking a VIP Pro out of a waiting room", () => {
  /** The room's parts the kicks use: its messages, and a clock run by hand. A month's counts, kept here. */
  function setup(staysLeft = 5) {
    const handlers = new Map<string, (client: any, msg: any) => void>();
    const timers: (() => void)[] = [];
    const room: any = {
      onMessage: (type: string, fn: any) => handlers.set(type, fn),
      clock: { setTimeout: (fn: () => void) => (timers.push(fn), { clear: () => timers.splice(timers.indexOf(fn), 1) }) },
    };
    const used = { kicks: 0, stays: 0 };
    const kicks = new Kicks(room, {
      kicksLeft: async () => 5 - used.kicks,
      staysLeft: async () => staysLeft - used.stays,
      useKick: async () => (used.kicks++, true),
      useStay: async () => (used.stays++, true),
    });
    const asked: unknown[] = [];
    const conn: any = { sessionId: "s1", send: (type: string, msg: unknown) => asked.push([type, msg]) };
    const answer = (stay: boolean) => handlers.get("kick_answer")!(conn, { stay });
    return { kicks, used, asked, conn, answer, timeUp: () => timers.shift()!() };
  }
  const pro = { uid: "pro", vip: "pro" }, host = { uid: "host", vip: "" }, otherPro = { uid: "p2", vip: "pro" };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("he stays: one stay spent, and nobody puts him out of this room again", async () => {
    const { kicks, used, asked, conn, answer } = setup();
    const out = kicks.decide(host, "Host", true, pro, conn);
    await tick();
    assert.deepStrictEqual(asked, [["kick_asked", { by: "Host", seconds: STAY_SECONDS, stays: 5 }]]);
    assert.deepStrictEqual(await kicks.decide(host, "Host", true, pro, conn), { code: "kick_pro_asking" });
    answer(true);
    assert.deepStrictEqual(await out, { code: "kick_pro_stayed" });
    assert.deepStrictEqual(await kicks.decide(otherPro, "Pro", false, pro, conn), { code: "kick_pro_stayed" });
    assert.deepStrictEqual(used, { kicks: 0, stays: 1 });
  });

  it("he leaves, or doesn't answer in time: he left (not kicked); a VIP Pro kicker's kick is spent", async () => {
    const a = setup();
    const out = a.kicks.decide(otherPro, "Pro", false, pro, a.conn);
    await tick();
    a.answer(false);
    assert.strictEqual(await out, "left");
    assert.deepStrictEqual(a.used, { kicks: 1, stays: 0 });
    const b = setup();
    const late = b.kicks.decide(host, "Host", true, pro, b.conn);
    await tick();
    b.timeUp();
    assert.strictEqual(await late, "left");
  });

  it("no stay left this month: kicked at once; only the host or a VIP Pro with kicks left may kick", async () => {
    const { kicks, asked, conn } = setup(0);
    assert.strictEqual(await kicks.decide(host, "Host", true, pro, conn), "kicked");
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(await kicks.decide({ uid: "v", vip: "vip" }, "Vip", false, host, conn), { code: "not_host" });
    assert.strictEqual(await kicks.decide(otherPro, "Pro", false, host, conn), "kicked");
  });
});
