/**
 * 8-ball: the app's physics, rules and bot (lib/billiard/billiard_physics.dart, billiard_rules.dart, billiard_bot.dart
 * in the app), line for line. The physics must give the app's result to the last bit: same operations in the same
 * order, only + − × ÷ and √ in a step (test/billiard.test.ts checks shots the app recorded). Change one, change both.
 */

export const clothW = 1000, clothH = 500;
export const ballR = 15.45;
const cushionDepth = 21;
const cornerHoleR = 32.1, cornerHoleOff = 15.1;
const middleHoleR = 25.2, middleHoleOff = 27.2;
const jawCornerBack = 16.7, jawCornerNose = 37.6;
const jawMiddleBack = 23.5, jawMiddleNose = 30.0;

export const tune = {
  maxSpeed: 2845,
  slide: 900,
  roll: 50,
  drag: 0.0003, // the cue ball's extra slowing, drag · speed² (8BP)
  cushionSpinKeep: 0.12, // the side spin left after a cushion (8BP)
  spinDecay: 8,
  ballBounce: 0.95,
  cushionBounce: 0.5, // + cushionBounceGain · the speed across, at most cushionBounceMax
  cushionBounceGain: 0.000168,
  cushionBounceMax: 0.95,
  cushionGrip: 0.035,
  spinReach: 0.19,
};

type Seg = { ax: number; ay: number; bx: number; by: number };
type Hole = { x: number; y: number; r: number };

export const holes: Hole[] = [
  { x: -cornerHoleOff, y: -cornerHoleOff, r: cornerHoleR },
  { x: clothW / 2, y: -middleHoleOff, r: middleHoleR },
  { x: clothW + cornerHoleOff, y: -cornerHoleOff, r: cornerHoleR },
  { x: -cornerHoleOff, y: clothH + cornerHoleOff, r: cornerHoleR },
  { x: clothW / 2, y: clothH + middleHoleOff, r: middleHoleR },
  { x: clothW + cornerHoleOff, y: clothH + cornerHoleOff, r: cornerHoleR },
];

const cushions: Seg[] = (() => {
  const c = cushionDepth, w = clothW, h = clothH, m = clothW / 2;
  const cb = jawCornerBack, cn = jawCornerNose, mb = jawMiddleBack, mn = jawMiddleNose;
  const rail = (p: [number, number][]) => p.slice(1).map(([bx, by], i) => ({ ax: p[i][0], ay: p[i][1], bx, by }));
  return [
    ...rail([[cb, -c], [cn, 0], [m - mn, 0], [m - mb, -c]]),
    ...rail([[m + mb, -c], [m + mn, 0], [w - cn, 0], [w - cb, -c]]),
    ...rail([[cb, h + c], [cn, h], [m - mn, h], [m - mb, h + c]]),
    ...rail([[m + mb, h + c], [m + mn, h], [w - cn, h], [w - cb, h + c]]),
    ...rail([[-c, cb], [0, cn], [0, h - cn], [-c, h - cb]]),
    ...rail([[w + c, cb], [w, cn], [w, h - cn], [w + c, h - cb]]),
  ];
})();

export type Ball = { n: number; x: number; y: number; vx: number; vy: number; wx: number; wy: number; wz: number; pottedIn: number | null };
export type Shot = { dx: number; dy: number; speed: number; side: number; height: number };

export const newBall = (n: number, x: number, y: number): Ball => ({ n, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, pottedIn: null });
export const copyBall = (b: Ball): Ball => ({ ...b });
const onTable = (b: Ball) => b.pottedIn === null;
const moving = (b: Ball) => b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0 || b.wz !== 0;

/** 8BP's cue: launch speed at points of its power bar (the app's powerTable), a straight line between them. */
const POWER: [number, number][] = [[0, 0], [0.338, 510], [0.55, 892], [0.756, 1423], [1, 2845]];
export function launchSpeed(power: number) {
  const p = Math.min(1, Math.max(0, power));
  for (let i = 1; i < POWER.length; i++) {
    const [p0, v0] = POWER[i - 1], [p1, v1] = POWER[i];
    if (p <= p1) return v0 + (v1 - v0) * (p - p0) / (p1 - p0);
  }
  return tune.maxSpeed;
}

export class ShotLog {
  firstHit: number | null = null;
  cushionAfterHit = new Set<number>();
  potted: number[] = [];
  holeOf = new Map<number, number>();
  anyCushion = false;
}

const DT = 1 / 1000;
const STOP = 0.5;

export class Sim {
  log = new ShotLog();
  constructor(readonly balls: Ball[]) {}

  get cue() {
    return this.balls.find((b) => b.n === 0)!;
  }

  shoot(s: Shot) {
    this.log = new ShotLog();
    const b = this.cue, v = s.speed;
    const len = Math.sqrt(s.dx * s.dx + s.dy * s.dy);
    const dx = s.dx / len, dy = s.dy / len;
    b.vx = dx * v;
    b.vy = dy * v;
    const k = 2.5 * tune.spinReach * s.height;
    b.wx = k * b.vy / ballR;
    b.wy = -k * b.vx / ballR;
    b.wz = -2.5 * tune.spinReach * s.side * v / ballR;
  }

  step(): boolean {
    const balls = this.balls;
    for (const b of balls) if (onTable(b) && moving(b)) this.cloth(b);
    for (const b of balls) {
      if (!onTable(b)) continue;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
    }
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!onTable(a)) continue;
      for (let j = i + 1; j < balls.length; j++) if (onTable(balls[j])) this.hit(a, balls[j]);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < balls.length; i++) {
        if (!onTable(balls[i])) continue;
        for (let j = i + 1; j < balls.length; j++) if (onTable(balls[j])) separate(balls[i], balls[j]);
      }
    }
    for (const a of balls) {
      if (!onTable(a)) continue;
      for (const s of cushions) this.cushion(a, s);
      for (let h = 0; h < holes.length; h++) {
        const o = holes[h], dx = a.x - o.x, dy = a.y - o.y;
        if (dx * dx + dy * dy < o.r * o.r) {
          a.pottedIn = h;
          a.vx = a.vy = a.wx = a.wy = a.wz = 0;
          this.log.potted.push(a.n);
          this.log.holeOf.set(a.n, h);
          break;
        }
      }
    }
    return balls.some((b) => onTable(b) && moving(b));
  }

  /** Runs the shot to its end (or [maxSteps]); the steps taken, 1 ms each. */
  run(maxSteps = 60000) {
    let n = 0;
    while (n < maxSteps && this.step()) n++;
    return n;
  }

  private cloth(b: Ball) {
    if (tune.drag > 0 && b.n === 0) {
      const s = Math.sqrt(b.vx * b.vx + b.vy * b.vy), k = 1 - tune.drag * s * DT;
      b.vx *= k;
      b.vy *= k;
      b.wx *= k;
      b.wy *= k;
    }
    const ux = b.vx + ballR * b.wy, uy = b.vy - ballR * b.wx;
    const u = Math.sqrt(ux * ux + uy * uy);
    if (u > 1e-6) {
      const du = 3.5 * tune.slide * DT;
      if (du >= u) {
        b.vx -= ux / 3.5;
        b.vy -= uy / 3.5;
        rolling(b);
      } else {
        const fx = -tune.slide * ux / u * DT, fy = -tune.slide * uy / u * DT;
        b.vx += fx;
        b.vy += fy;
        b.wx -= 2.5 * fy / ballR;
        b.wy += 2.5 * fx / ballR;
      }
    } else {
      const s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const s2 = s - tune.roll * DT;
      if (s2 <= STOP) {
        b.vx = b.vy = 0;
      } else {
        b.vx *= s2 / s;
        b.vy *= s2 / s;
      }
      rolling(b);
    }
    const dz = tune.spinDecay * DT;
    b.wz = Math.abs(b.wz) <= dz ? 0 : b.wz - (b.wz > 0 ? dz : -dz);
  }

  private hit(a: Ball, b: Ball) {
    const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, r2 = 4 * ballR * ballR;
    if (d2 >= r2 || d2 === 0) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (rel > 0) {
      const j = (1 + tune.ballBounce) / 2 * rel;
      a.vx -= j * nx;
      a.vy -= j * ny;
      b.vx += j * nx;
      b.vy += j * ny;
      if (a.n === 0 && this.log.firstHit === null) this.log.firstHit = b.n;
      if (b.n === 0 && this.log.firstHit === null) this.log.firstHit = a.n;
    }
    separate(a, b);
  }

  private cushion(b: Ball, s: Seg) {
    const ex = s.bx - s.ax, ey = s.by - s.ay;
    let t = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / (ex * ex + ey * ey);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const qx = s.ax + ex * t, qy = s.ay + ey * t;
    const dx = b.x - qx, dy = b.y - qy, d2 = dx * dx + dy * dy;
    if (d2 >= ballR * ballR || d2 === 0) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const tx = -ny, ty = nx;
      const vt = b.vx * tx + b.vy * ty;
      const ut = -ballR * b.wz;
      const e = Math.min(tune.cushionBounceMax, tune.cushionBounce + tune.cushionBounceGain * -vn);
      const p = (1 + e) * -vn;
      let f = -ut / 3.5;
      const fmax = tune.cushionGrip * p;
      if (f > fmax) f = fmax;
      if (f < -fmax) f = -fmax;
      const vn2 = -e * vn, vt2 = vt + f;
      b.vx = vn2 * nx + vt2 * tx;
      b.vy = vn2 * ny + vt2 * ty;
      b.wz -= 2.5 * f / ballR;
      rolling(b); // it leaves the cushion rolling its new way, most of its side spin spent (8BP)
      b.wz *= tune.cushionSpinKeep;
      if (this.log.firstHit !== null) this.log.cushionAfterHit.add(b.n);
      this.log.anyCushion = true;
    }
    b.x = qx + nx * ballR;
    b.y = qy + ny * ballR;
  }
}

function rolling(b: Ball) {
  b.wx = b.vy / ballR;
  b.wy = -b.vx / ballR;
}

function separate(a: Ball, b: Ball) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  if (d2 >= 4 * ballR * ballR || d2 === 0) return;
  const d = Math.sqrt(d2), push = (2 * ballR - d) / 2;
  a.x -= dx / d * push;
  a.y -= dy / d * push;
  b.x += dx / d * push;
  b.y += dy / d * push;
}

export function rack(cueX = 250, cueY = clothH / 2): Ball[] {
  const order = [1, 9, 2, 10, 8, 3, 11, 4, 5, 12, 6, 13, 14, 7, 15];
  const out = [newBall(0, cueX, cueY)];
  const dx = ballR * Math.sqrt(3) + 0.01, dy = 2 * ballR + 0.01;
  let k = 0;
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row <= col; row++) out.push(newBall(order[k++], 750 + col * dx, clothH / 2 + (row - col / 2) * dy));
  }
  return out;
}

// ---- the rules (billiard_rules.dart) ----

export type Group = "solids" | "stripes";
export const groupOf = (n: number): Group | null => (n >= 1 && n <= 7 ? "solids" : n >= 9 && n <= 15 ? "stripes" : null);

export type Outcome = {
  foul: string | null; // "scratch" | "no_hit" | "wrong_ball" | "no_rail" | "time"
  keepsTurn: boolean;
  assigned: Group | null;
  winner: number | null;
  end: string | null; // "eight" | "eight_early" | "eight_wrong_pocket" | "eight_foul"
  rerack: boolean;
};

const outcome = (o: Partial<Outcome>): Outcome => ({ foul: null, keepsTurn: false, assigned: null, winner: null, end: null, rerack: false, ...o });

export class EightBall {
  groups: (Group | null)[] = [null, null];
  breakShot = true;
  ballInHand = true;
  kitchenOnly = true;
  winner: number | null = null;
  constructor(public turn = 0) {}

  copy() {
    const g = new EightBall(this.turn);
    g.groups = [...this.groups];
    g.breakShot = this.breakShot;
    g.ballInHand = this.ballInHand;
    g.kitchenOnly = this.kitchenOnly;
    g.winner = this.winner;
    return g;
  }

  onEight(player: number, table: Iterable<number>) {
    const g = this.groups[player];
    return g !== null && ![...table].some((n) => groupOf(n) === g);
  }

  targets(player: number, table: Iterable<number>) {
    if (this.onEight(player, table)) return new Set([8]);
    const g = this.groups[player];
    return new Set([...table].filter((n) => n !== 0 && n !== 8 && (g === null || groupOf(n) === g)));
  }

  play(log: ShotLog, before: Set<number>, called: number | null): Outcome {
    const me = this.turn, other = 1 - this.turn;
    const wasOnEight = this.onEight(me, before);
    const allowed = this.targets(me, before);
    const potted = log.potted.filter((n) => n !== 0);
    let foul: string | null = null;
    if (log.potted.includes(0)) foul = "scratch";
    else if (log.firstHit === null) foul = "no_hit";
    else if (!this.breakShot && !allowed.has(log.firstHit)) foul = "wrong_ball";
    else if (!this.breakShot && potted.length === 0 && log.cushionAfterHit.size === 0) foul = "no_rail";
    const wasBreak = this.breakShot;
    this.breakShot = false;
    this.kitchenOnly = false;

    if (potted.includes(8)) {
      if (wasBreak) {
        this.breakShot = true;
        this.ballInHand = this.kitchenOnly = true;
        return outcome({ rerack: true, keepsTurn: true });
      }
      // His last balls went down before the 8, in this same shot: he was on the 8 when it dropped (no call possible).
      const mine = this.groups[me], eightAt = log.potted.indexOf(8);
      const cleared = mine !== null && [...before].filter((n) => groupOf(n) === mine).every((n) => {
        const i = log.potted.indexOf(n);
        return i >= 0 && i < eightAt;
      });
      const legal = foul === null && (wasOnEight ? log.holeOf.get(8) === called : cleared);
      this.winner = legal ? me : other;
      return outcome({
        foul,
        winner: this.winner,
        end: legal ? "eight" : !wasOnEight && !cleared ? "eight_early" : foul !== null ? "eight_foul" : "eight_wrong_pocket",
      });
    }

    let assigned: Group | null = null;
    if (!wasBreak && this.groups[me] === null && foul === null && potted.length > 0) {
      assigned = groupOf(potted[0]);
      this.groups[me] = assigned;
      this.groups[other] = assigned === "solids" ? "stripes" : "solids";
    }
    const mine = this.groups[me];
    const scored = potted.some((n) => mine === null || groupOf(n) === mine);
    const keeps = foul === null && scored;
    if (!keeps) this.turn = other;
    this.ballInHand = foul !== null;
    return outcome({ foul, keepsTurn: keeps, assigned });
  }

  /** The shot clock ran out: a foul, the other player gets the cue ball anywhere. */
  outOfTime(): Outcome {
    this.turn = 1 - this.turn;
    this.ballInHand = true;
    this.kitchenOnly = false;
    this.breakShot = false;
    return outcome({ foul: "time" });
  }
}

// ---- the bot (billiard_bot.dart) ----

export type BotPlan = { shot: Shot; pocket: number | null; place: [number, number] | null };
const D = 2 * ballR;

/** Its shot for this table; [skill] 0..1 is how little its aim and power wobble. */
export function botPlan(input: Ball[], game: EightBall, skill: number, rnd: () => number = Math.random): BotPlan {
  const me = game.turn;
  const balls = input.map(copyBall);
  const cue = balls.find((b) => b.n === 0)!;
  const table = new Set(balls.filter((b) => onTable(b) && b.n !== 0).map((b) => b.n));
  const shot = (dx: number, dy: number, speed: number): Shot => ({ dx, dy, speed, side: 0, height: 0 });

  if (game.breakShot) {
    const y = clothH / 2 + (rnd() - 0.5) * 60;
    const dx = 750 - 250, dy = clothH / 2 - y, l = Math.sqrt(dx * dx + dy * dy);
    return { shot: shot(dx / l, dy / l, launchSpeed(1)), pocket: null, place: [250, y] };
  }

  const targets = game.targets(me, table);
  let place: [number, number] | null = null;
  if (game.ballInHand || !onTable(cue)) {
    place = placement(balls, targets, game.kitchenOnly) ?? [250, clothH / 2];
    cue.x = place[0];
    cue.y = place[1];
    cue.pottedIn = null;
  }

  const cands: { n: number; h: number; dx: number; dy: number; value: number }[] = [];
  for (const n of targets) {
    const o = balls.find((b) => b.n === n)!;
    for (let h = 0; h < holes.length; h++) {
      const hole = holes[h];
      let ux = hole.x - o.x, uy = hole.y - o.y;
      const lo = Math.sqrt(ux * ux + uy * uy);
      ux /= lo;
      uy /= lo;
      if ((h === 1 || h === 4) && Math.abs(uy) < 0.35) continue;
      const gx = o.x - ux * D, gy = o.y - uy * D;
      let dx = gx - cue.x, dy = gy - cue.y;
      const lc = Math.sqrt(dx * dx + dy * dy);
      if (lc < 1) continue;
      dx /= lc;
      dy /= lc;
      const cut = dx * ux + dy * uy;
      if (cut < 0.2) continue;
      if (!clear(balls, cue.x, cue.y, gx, gy, [0, n])) continue;
      if (!clear(balls, o.x, o.y, hole.x, hole.y, [0, n])) continue;
      cands.push({ n, h, dx, dy, value: cut * cut / (1 + lc / 700 + lo / 700) });
    }
  }
  cands.sort((a, b) => b.value - a.value);

  let best: BotPlan | null = null;
  let bestValue = -Infinity;
  for (const c of cands.slice(0, 6)) {
    for (const power of [0.42, 0.6, 0.8]) {
      const s = shot(c.dx, c.dy, launchSpeed(power));
      const v = trial(balls, game, s, c.h);
      if (v > bestValue) {
        bestValue = v;
        best = { shot: s, pocket: c.h, place };
      }
    }
  }
  if (best === null || bestValue < 0) {
    for (const n of targets) {
      const o = balls.find((b) => b.n === n)!;
      for (const [ax, ay] of [
        [o.x, o.y],
        [2 * ballR - o.x, o.y],
        [2 * (clothW - ballR) - o.x, o.y],
        [o.x, 2 * ballR - o.y],
        [o.x, 2 * (clothH - ballR) - o.y],
      ]) {
        const dx = ax - cue.x, dy = ay - cue.y, l = Math.sqrt(dx * dx + dy * dy);
        const s = shot(dx / l, dy / l, launchSpeed(0.6));
        const v = trial(balls, game, s, 0);
        if (v > bestValue) {
          bestValue = v;
          best = { shot: s, pocket: 0, place };
        }
      }
    }
    best ??= { shot: shot(1, 0, launchSpeed(0.5)), pocket: 0, place };
  }
  const gauss = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const err = (rnd() * 2 - 1) * (1 - skill) * 0.035 + gauss * (1 - skill) * 0.01;
  const c = Math.cos(err), s = Math.sin(err);
  const sh = best.shot;
  const speed = sh.speed * (1 + (rnd() - 0.5) * 0.12 * (1 - skill));
  return { shot: shot(sh.dx * c - sh.dy * s, sh.dx * s + sh.dy * c, speed), pocket: best.pocket, place: best.place };
}

function clear(balls: Ball[], ax: number, ay: number, bx: number, by: number, skip: number[]) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  for (const b of balls) {
    if (!onTable(b) || skip.includes(b.n)) continue;
    const t = Math.min(1, Math.max(0, ((b.x - ax) * ex + (b.y - ay) * ey) / l2));
    const qx = ax + ex * t - b.x, qy = ay + ey * t - b.y;
    if (qx * qx + qy * qy < D * D * 0.96) return false;
  }
  return true;
}

function trial(balls: Ball[], game: EightBall, s: Shot, hole: number) {
  const copy = balls.map(copyBall);
  const before = new Set(copy.filter((b) => onTable(b) && b.n !== 0).map((b) => b.n));
  const sim = new Sim(copy);
  sim.shoot(s);
  sim.run(7000);
  const g = game.copy(), me = g.turn;
  const o = g.play(sim.log, before, hole);
  if (o.winner !== null) return o.winner === me ? 1000 : -1000;
  let v = o.foul !== null ? -300 : o.keepsTurn ? 200 : 0;
  v += sim.log.potted.filter((n) => n !== 0 && g.groups[me] !== null && groupOf(n) === g.groups[me]).length * 40;
  const cue = copy.find((b) => b.n === 0)!;
  if (onTable(cue)) {
    const edge = Math.min(Math.min(cue.x, clothW - cue.x), Math.min(cue.y, clothH - cue.y));
    v += Math.min(edge, 120) / 12;
  }
  return v;
}

function placement(balls: Ball[], targets: Set<number>, kitchenOnly: boolean): [number, number] | null {
  let best: [number, number] | null = null;
  let bestScore = -1;
  for (const n of targets) {
    const o = balls.find((b) => b.n === n)!;
    for (const hole of holes) {
      const ux = hole.x - o.x, uy = hole.y - o.y, lo = Math.sqrt(ux * ux + uy * uy);
      const x = o.x - ux / lo * (D + 3 * D), y = o.y - uy / lo * (D + 3 * D);
      if (x < ballR || x > clothW - ballR || y < ballR || y > clothH - ballR) continue;
      if (kitchenOnly && x > 250) continue;
      if (balls.some((b) => onTable(b) && b.n !== 0 && (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) < D * D * 1.05)) continue;
      if (!clear(balls, o.x, o.y, hole.x, hole.y, [0, n])) continue;
      const score = 1 / (1 + lo / 400);
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
  }
  return best;
}

/** Whether the cue ball may be put at (x, y): on the cloth (behind the head string at the break), touching no ball. */
export function freeSpot(balls: Ball[], x: number, y: number, kitchenOnly: boolean) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < ballR || x > (kitchenOnly ? 250 : clothW - ballR) || y < ballR || y > clothH - ballR) return false;
  return balls.every((b) => b.n === 0 || !onTable(b) || (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) > 4 * ballR * ballR);
}
