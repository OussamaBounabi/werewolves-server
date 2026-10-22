import assert from "assert";
import { readFileSync } from "fs";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { BilliardRoom } from "../src/rooms/BilliardRoom.js";
import { botPlan, EightBall, newBall, rack, ShotLog, Sim, type Ball } from "../src/billiard.js";

describe("billiard", () => {
  // The app played these shots (its test/billiard_golden_test.dart): every ball must end where it ended there, to the bit.
  it("ends every shot exactly as the app does", () => {
    const cases = JSON.parse(readFileSync(new URL("./billiard_golden.json", import.meta.url), "utf8"));
    for (const [i, c] of cases.entries()) {
      const balls: Ball[] = c.start.map(([n, x, y]: number[]) => newBall(n, x, y));
      const sim = new Sim(balls);
      const [dx, dy, speed, side, height] = c.shot;
      sim.shoot({ dx, dy, speed, side, height });
      assert.strictEqual(sim.run(), c.steps, `case ${i}: steps`);
      assert.strictEqual(sim.log.firstHit, c.firstHit, `case ${i}: first hit`);
      assert.deepStrictEqual(sim.log.potted.map((n) => [n, sim.log.holeOf.get(n)]), c.potted, `case ${i}: potted`);
      assert.deepStrictEqual(balls.filter((b) => b.pottedIn === null).map((b) => [b.n, b.x, b.y]), c.end, `case ${i}: where they stopped`);
    }
  });

  it("my last ball and then the 8 in one shot wins; balls left, it loses", () => {
    const game = () => Object.assign(new EightBall(), { breakShot: false, ballInHand: false, kitchenOnly: false, groups: ["solids", "stripes"] });
    const log = (potted: number[]) => Object.assign(new ShotLog(), { firstHit: 7, potted, holeOf: new Map(potted.map((n) => [n, 4])), cushionAfterHit: new Set([7]) });
    assert.strictEqual(game().play(log([7, 8]), new Set([7, 8, 9]), null).end, "eight");
    assert.strictEqual(game().play(log([8, 7]), new Set([7, 8, 9]), null).end, "eight_early");
    assert.strictEqual(game().play(log([7, 8]), new Set([6, 7, 8, 9]), null).end, "eight_early");
  });

  it("a bot game ends with a winner", function () {
    this.timeout(120_000);
    let balls = rack();
    const game = new EightBall();
    let shots = 0;
    while (game.winner === null && shots < 150) {
      const plan = botPlan(balls, game.copy(), 0.75);
      const cue = balls.find((b) => b.n === 0)!;
      if (plan.place) [cue.x, cue.y, cue.pottedIn] = [plan.place[0], plan.place[1], null];
      const before = new Set(balls.filter((b) => b.pottedIn === null && b.n !== 0).map((b) => b.n));
      const sim = new Sim(balls);
      sim.shoot(plan.shot);
      assert.ok(sim.run() < 60000);
      const o = game.play(sim.log, before, plan.pocket);
      shots++;
      if (o.rerack) balls = rack();
      else if (cue.pottedIn !== null) [cue.x, cue.y, cue.pottedIn] = [250, 250 + 3 * 15.45, null];
    }
    assert.notStrictEqual(game.winner, null);
  });
});

describe("BilliardRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    BilliardRoom.botSpeed = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    BilliardRoom.botSpeed = 1;
    await colyseus.shutdown();
  });

  it("a player's shot is played and told; a bot seat answers", async function () {
    this.timeout(30_000);
    const room: any = await colyseus.createRoom("billiard", {});
    const host = await colyseus.connectTo(room);
    let table: any = null;
    const shots: any[] = [];
    host.onMessage("billiard", (m) => (table = m));
    host.onMessage("billiard_shot", (m) => shots.push(m));
    host.onMessage("billiard_aim", () => {});
    host.onMessage("billiard_fx", () => {});
    host.send("add_bot", { level: "hard" });
    await new Promise((r) => setTimeout(r, 100));
    host.send("start_game");
    while (room.phase !== "playing") await new Promise((r) => setTimeout(r, 20));
    // whoever breaks: the bot's break, or mine
    if (room.game.turn === 0) {
      await new Promise((r) => setTimeout(r, 100));
      host.send("shot", { dx: 1, dy: 0, speed: 2000, side: 0, height: 0, place: [100, 100] }); // no ball between: still sound
      host.send("shot", { dx: 1, dy: 0, speed: 99999, place: [250, 250] }); // too fast: refused
    }
    const deadline = Date.now() + 10_000;
    while (shots.length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const s = shots[0];
    assert.ok(s, "a shot was told");
    assert.strictEqual(s.start[0][0], 0, "the cue ball first");
    // the app replays it from the same start and lands where the server says
    const balls: Ball[] = s.start.map(([n, x, y]: number[]) => newBall(n, x, y));
    const sim = new Sim(balls);
    const [dx, dy, speed, side, height] = s.shot;
    sim.shoot({ dx, dy, speed, side, height });
    assert.strictEqual(sim.run(), s.steps);
    assert.deepStrictEqual(balls.filter((b) => b.pottedIn === null).map((b) => [b.n, b.x, b.y]), s.end);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(table.shots, shots.length);
  });
});
