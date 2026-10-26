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
      assert.deepStrictEqual([...sim.log.rails].map(([n, r]) => [n, [...r]]), c.rails, `case ${i}: cushions touched`);
      assert.deepStrictEqual([...sim.log.kick], c.kick, `case ${i}: the cue ball's cushions before its first hit`);
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

  it("pockets called for every ball: only a ball in the named pocket keeps the table", () => {
    const game = () => Object.assign(new EightBall(0, { callAll: true }), { breakShot: false, ballInHand: false, kitchenOnly: false, groups: ["solids", "stripes"] });
    const log = (hole: number) => Object.assign(new ShotLog(), { firstHit: 3, potted: [3], holeOf: new Map([[3, hole]]), cushionAfterHit: new Set([3]) });
    const elsewhere = game(), right = game();
    const o = elsewhere.play(log(2), new Set([3, 4, 8, 9]), 5);
    assert.deepStrictEqual([o.foul, o.keepsTurn, elsewhere.turn, elsewhere.ballInHand], [null, false, 1, false], "turn over, no foul");
    assert.strictEqual(right.play(log(5), new Set([3, 4, 8, 9]), 5).keepsTurn, true);
    assert.strictEqual(game().mustCall(0, [3, 9]), true);
  });

  it("the 8 banked: its cushions named, two then one then straight; a cushion missed loses", () => {
    const onEight = () => Object.assign(new EightBall(0, { banks: true }), { breakShot: false, ballInHand: false, kitchenOnly: false, groups: ["solids", "stripes"] });
    const eight = (rails: number[], potted = true) =>
      Object.assign(new ShotLog(), { firstHit: 8, potted: potted ? [8] : [], holeOf: new Map(potted ? [[8, 4]] : []), cushionAfterHit: new Set([8]), rails: new Map([[8, new Set(rails)]]) });
    assert.strictEqual(onEight().play(eight([0, 5]), new Set([8, 9]), 4, [5, 0]).end, "eight", "any order");
    assert.strictEqual(onEight().play(eight([0, 3]), new Set([8, 9]), 4, [5, 0]).end, "eight_no_bank");
    assert.strictEqual(onEight().play(eight([0, 5]), new Set([8, 9]), 2, [5, 0]).end, "eight_wrong_pocket");
    const kicked = (cue: number[], eightRails: number[]) => Object.assign(eight(eightRails), { kick: new Set(cue) });
    assert.strictEqual(onEight().play(kicked([5, 0], []), new Set([8, 9]), 4, [5, 0]).end, "eight", "the cue ball's cushions");
    assert.strictEqual(onEight().play(kicked([5], [0]), new Set([8, 9]), 4, [5, 0]).end, "eight", "one each");
    assert.strictEqual(onEight().play(kicked([5], []), new Set([8, 9]), 4, [5, 0]).end, "eight_no_bank");
    const g = onEight();
    g.play(eight([], false), new Set([8, 9]), 4, [5, 0]); // missed: one cushion less next time
    assert.deepStrictEqual(g.banks, [1, 2]);
    g.turn = 0;
    g.outOfTime([8, 9]);
    assert.deepStrictEqual(g.banks, [0, 2], "a turn on the 8 run out counts too");
    g.turn = 0;
    assert.strictEqual(g.play(eight([]), new Set([8, 9]), 4, []).end, "eight", "straight in at last");
  });

  it("a bot banks the 8 and names what it did, or plays safe", function () {
    this.timeout(60_000);
    const balls = [newBall(0, 300, 250), newBall(8, 500, 250), newBall(9, 800, 100)];
    const game = Object.assign(new EightBall(0, { banks: true }), { breakShot: false, ballInHand: false, kitchenOnly: false, groups: ["solids", "stripes"] });
    const plan = botPlan(balls, game.copy(), 1, () => 0.5);
    assert.strictEqual(plan.rails.length, 2);
    const sim = new Sim(balls.map((b) => ({ ...b })));
    sim.shoot(plan.shot);
    sim.run();
    const o = game.copy().play(sim.log, new Set([8, 9]), plan.pocket, plan.rails);
    assert.ok(o.winner === null || o.winner === 0, `a bank it tried loses only by its own wobble: ${o.end}`);
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
    const t = [...room.tables.values()][0];
    if (t.players[t.game.turn] === host.sessionId) {
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

  const until = async (ok: () => boolean, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("a cup of 4: both semi-finals at once, each at its own table, then the final with everyone", async function () {
    this.timeout(120_000);
    const room: any = await colyseus.createRoom("billiard", { mode: "cup", cupSize: 4, bestOf: 1 });
    const host = await colyseus.connectTo(room);
    let seen: any = null;
    const shotTables = new Set<number>();
    host.onMessage("billiard", (m) => (seen = m));
    host.onMessage("billiard_shot", (m) => shotTables.add(m.table));
    for (const m of ["billiard_aim", "billiard_pick", "billiard_fx", "chat_history"]) host.onMessage(m, () => {});
    for (const level of ["hard", "hard", "hard"]) host.send("add_bot", { level });
    await until(() => room.seats.length === 4);
    room.seats[0].bot = "hard"; // (the host's own games played by a bot, for the test)
    host.send("start_game");
    await until(() => room.tables.size === 2);
    const [a, b] = [...room.tables.values()];
    assert.notDeepStrictEqual(a.players, b.players);
    assert.strictEqual(new Set([...a.players, ...b.players]).size, 4, "everyone plays a semi-final");
    await until(() => room.phase === "gameover");
    const final = room.matches[2];
    assert.ok(final.winner && room.champion === final.winner);
    assert.strictEqual(room.seats.filter((s: any) => s.out).length, 3, "three lost a match");
    assert.ok(shotTables.size >= 2, "the host saw his table's shots, then the final's");
    assert.strictEqual(seen.phase, "gameover");
    assert.strictEqual(seen.table, [...room.tables.values()].find((x: any) => x.match === 2).id, "everyone at the final");
  });

  it("winner stays: the loser to the back of the line, the next plays the winner, stars counted", async function () {
    this.timeout(120_000);
    const room: any = await colyseus.createRoom("billiard", { mode: "king", minutes: 15 });
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const c = await colyseus.connectTo(room, { name: `P${i}` });
      for (const m of ["billiard", "billiard_shot", "billiard_aim", "billiard_pick", "billiard_fx", "chat_history"]) c.onMessage(m, () => {});
      clients.push(c);
    }
    clients[0].send("add_bot", { level: "hard" }); // no bots here
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(room.seats.length, 3);
    clients[0].send("start_game");
    await until(() => room.phase === "playing");
    const t: any = [...room.tables.values()][0];
    const [first, second] = t.players, waiting = room.queue[0];
    for (const s of room.seats) s.bot = "hard"; // (their shots played by bots, for the test)
    room.botTurn(t, 0);
    await until(() => t.games === 2);
    const winner = room.seats.find((s: any) => s.wins === 1).id, loser = winner === first ? second : first;
    assert.deepStrictEqual(t.players, [winner, waiting], "the winner stays, the next in line plays him");
    assert.deepStrictEqual(room.queue, [loser], "the loser at the back");
    room.endsAt = 0; // time's up: this game is the last
    await until(() => room.phase === "gameover");
    const best = Math.max(...room.seats.map((s: any) => s.wins));
    assert.strictEqual(room.seat(room.champion).wins, best);
    assert.strictEqual(room.seats.reduce((n: number, s: any) => n + s.wins, 0), 2, "a star a game");
  });

  it("the pocket and cushions named go to the table at once", async function () {
    this.timeout(30_000);
    const room: any = await colyseus.createRoom("billiard", { callAll: true });
    const a = await colyseus.connectTo(room), b = await colyseus.connectTo(room);
    const picks: any[] = [];
    for (const c of [a, b]) for (const m of ["billiard", "billiard_shot", "billiard_aim", "billiard_fx", "chat_history"]) c.onMessage(m, () => {});
    a.onMessage("billiard_pick", (m) => picks.push(["a", m]));
    b.onMessage("billiard_pick", (m) => picks.push(["b", m]));
    a.send("start_game");
    await until(() => room.phase === "playing");
    const t: any = [...room.tables.values()][0];
    const [shooter, other] = t.players[t.game.turn] === a.sessionId ? [a, "b"] : [b, "a"];
    shooter.send("pick", { called: 3, rails: [] });
    shooter.send("pick", { called: 9, rails: [] }); // no such pocket: ignored
    await until(() => picks.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(picks, [[other, { table: t.id, called: 3, rails: [] }]]);
    assert.deepStrictEqual(t.pick, { called: 3, rails: [] });
  });
});
