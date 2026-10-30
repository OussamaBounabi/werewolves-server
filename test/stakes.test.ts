import assert from "node:assert";
import { cleanStakePlan } from "../src/plans.js";
import { cupPlaces, StakeTable } from "../src/rooms/stake.js";
import { share, type Wallet } from "../src/stakes.js";

const wait = () => new Promise((r) => setTimeout(r, 20));

describe("stakes", () => {
  const all = (...ids: string[]) => new Set(ids);
  const pot = (n: number, ...ids: string[]) => new Map(ids.map((id) => [id, n]));
  const money = (m: Map<string, number>) => Object.fromEntries(m);

  it("the winners share the pot less the house's 10%; a draw gives each his own back less the cut", () => {
    assert.deepStrictEqual(money(share(pot(100, "a", "b"), all("a", "b"), [["a"]], 10)), { a: 180 });
    // 2 vs 2: 400 in, 360 out, 180 each.
    assert.deepStrictEqual(money(share(pot(100, "a", "b", "c", "d"), all("a", "b", "c", "d"), [["a", "c"]], 10)), { a: 180, c: 180 });
    assert.deepStrictEqual(money(share(pot(100, "a", "b"), all("a", "b"), [], 10)), { a: 90, b: 90 });
    // Who left gets nothing, even in a draw; a winner who left: those still at the table share it.
    assert.deepStrictEqual(money(share(pot(100, "a", "b"), all("b"), [], 10)), { b: 90 });
    assert.deepStrictEqual(money(share(pot(100, "a", "b", "c"), all("b", "c"), [["a"]], 10)), { b: 135, c: 135 });
  });

  it("a cup: 70/30 for 4 players, 60/30/10 for more, the two semi-final losers sharing the third place", () => {
    const four = pot(100, "a", "b", "c", "d");
    assert.deepStrictEqual(money(share(four, all("a", "b", "c", "d"), [["a"], ["b"], ["c", "d"]], 10, true)), { a: 252, b: 108 });
    const eight = pot(100, "a", "b", "c", "d", "e", "f", "g", "h");
    const players = all("a", "b", "c", "d", "e", "f", "g", "h");
    assert.deepStrictEqual(money(share(eight, players, [["a"], ["b"], ["c", "d"]], 10, true)), { a: 432, b: 216, c: 36, d: 36 });
  });

  it("a cup's places from its bracket: champion, runner-up, the two semi-final losers", () => {
    const m = (a: string, b: string, winner: string) => ({ a, b, winner, rounds: [] as number[] });
    // 8: quarter-finals 0–3, semi-finals 4 and 5, the final 6.
    const eight = [m("a", "b", "a"), m("c", "d", "c"), m("e", "f", "f"), m("g", "h", "g"), m("a", "c", "c"), m("f", "g", "f"), m("c", "f", "f")];
    assert.deepStrictEqual(cupPlaces(eight), [["f"], ["c"], ["a", "g"]]);
    // 4: semi-finals 0 and 1, the final 2.
    assert.deepStrictEqual(cupPlaces([m("a", "b", "b"), m("c", "d", "c"), m("b", "c", "b")]), [["b"], ["c"], ["a", "d"]]);
  });

  it("the admin's plan: a cut of 0–50%, levels once each, smallest first", () => {
    const plan = cleanStakePlan({ cut: 80, levels: [{ amount: 500, minLevel: 3 }, { amount: 100 }, { amount: 500, minLevel: 9 }] });
    assert.deepStrictEqual(plan, { cut: 50, levels: [{ amount: 100, minLevel: 1 }, { amount: 500, minLevel: 3 }] });
  });

  describe("a table", () => {
    let coins: Record<string, number>;
    const logs: any[] = [];
    const fake: Wallet = {
      take: async (id, n) => (coins[id] >= n ? ((coins[id] -= n), "ok") : "stake_coins"),
      give: async (id, n) => void (coins[id] += n),
      log: async (row) => void logs.push(row),
    };
    before(() => (StakeTable.wallet = fake));
    beforeEach(() => (coins = { a: 1000, b: 1000, c: 50 }));

    it("takes everyone's stake and pays the winner; one who can't pay: nobody pays, the game doesn't start", async () => {
      const table = new StakeTable("chess", { roomId: "r1" });
      table.set(100);
      table.set(123); // not a level: ignored
      assert.strictEqual(table.amount, 100);
      let started = 0;
      let failed: any = null;
      table.begin([{ playerId: "a", name: "A" }, { playerId: "c", name: "C" }], () => void started++, (why) => (failed = why));
      await wait();
      assert.deepStrictEqual([started, failed, coins.a, coins.c], [0, { code: "stake_coins", name: "C" }, 1000, 50]);
      table.begin([{ playerId: "a", name: "A" }, { playerId: "b", name: "B" }], () => void started++, () => {});
      await wait();
      assert.deepStrictEqual([started, coins.a, coins.b], [1, 900, 900]);
      table.settle(["b"]);
      await wait();
      assert.deepStrictEqual([coins.a, coins.b], [900, 1080]);
      assert.deepStrictEqual(table.last, [{ id: "a", name: "A", got: 0 }, { id: "b", name: "B", got: 180 }]);
      assert.deepStrictEqual([logs.at(-1).pot, logs.at(-1).result], [200, "won"]);
    });

    it("the room closing mid-game gives back the stakes of those still there", async () => {
      const table = new StakeTable("domino", { roomId: "r2" });
      table.set(500);
      table.begin([{ playerId: "a", name: "A" }, { playerId: "b", name: "B" }], () => {}, () => {});
      await wait();
      table.leave("a");
      table.refund();
      await wait();
      assert.deepStrictEqual([coins.a, coins.b], [500, 1000]);
      table.refund(); // (nothing left to give)
      assert.deepStrictEqual([coins.a, coins.b], [500, 1000]);
    });
  });
});
