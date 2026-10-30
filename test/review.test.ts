import assert from "node:assert";
import { fromUci, makeMove, startPos, type ChessPos } from "../src/chess.js";
import { isSacrifice, mark, moveAccuracy, ratingFromAccuracy, review, winChance } from "../src/review.js";

describe("game review", () => {
  it("winning chances, accuracies and ratings as the scale says", () => {
    assert.strictEqual(winChance({ cp: 0 }), 50);
    assert.ok(winChance({ cp: 300 }) > 70 && winChance({ cp: 300 }) < 80);
    assert.deepStrictEqual([winChance({ mate: 3 }), winChance({ mate: -2 })], [100, 0]);
    assert.ok(Math.abs(moveAccuracy(0) - 100) < 0.01);
    assert.ok(moveAccuracy(20) < 45 && moveAccuracy(20) > 35);
    assert.deepStrictEqual([50, 70, 90, 100].map(ratingFromAccuracy), [400, 1200, 2200, 3100]);
  });

  it("marks: the engine's move, an only move, a sacrifice; the loss for the others", () => {
    const m = (loss: number, extra = {}) => mark({ loss, best: false, onlyMove: false, sacrifice: false, after: 50, ...extra });
    assert.deepStrictEqual([m(1), m(3), m(6), m(12), m(25)], ["excellent", "good", "inaccuracy", "mistake", "blunder"]);
    assert.strictEqual(m(0, { best: true }), "best");
    assert.strictEqual(m(0, { best: true, onlyMove: true }), "great");
    assert.strictEqual(m(0, { best: true, sacrifice: true }), "brilliant");
    assert.strictEqual(m(0, { best: true, sacrifice: true, after: 20 }), "best", "a sacrifice that loses isn't brilliant");
  });

  it("a sacrifice: a piece left where it's taken", () => {
    let pos: ChessPos = startPos();
    for (const t of ["e2e4", "e7e5", "g1f3", "b8c6"]) pos = makeMove(pos, fromUci(pos, t)!);
    assert.ok(!isSacrifice(pos, fromUci(pos, "f1c4")!), "Bc4: nobody takes it");
    assert.ok(isSacrifice(pos, fromUci(pos, "f3g5")!), "Ng5: the d8 queen takes it (e7 has gone)");
    assert.ok(isSacrifice(pos, fromUci(pos, "f1b5")!) === false, "Bb5: not attacked by anything");
    assert.ok(isSacrifice(pos, fromUci(pos, "f3e5")!), "Nxe5: the knight is taken back by the c6 knight");
  });

  it("a whole review: a mark a move, each side's accuracy and rating", () => {
    let pos: ChessPos = startPos();
    const positions = [pos], moves = [];
    for (const t of ["e2e4", "e7e5", "d1h5"]) {
      const move = fromUci(pos, t)!;
      moves.push({ uci: t, move });
      pos = makeMove(pos, move);
      positions.push(pos);
    }
    // The engine: e4 best (+30), e5 best (−30 for black … +30 for white), Qh5 gives away a lot (black then +200).
    const seen = [
      { best: "e2e4", score: { cp: 30 } },
      { best: "e7e5", score: { cp: -30 } },
      { best: "g1f3", score: { cp: 30 } },
      { best: "b8c6", score: { cp: 200 } },
    ];
    const r = review(positions, moves, seen);
    assert.deepStrictEqual(r.marks.slice(0, 2), ["best", "best"]);
    assert.ok(["mistake", "blunder", "inaccuracy"].includes(r.marks[2]), r.marks[2]);
    assert.ok(r.white.accuracy < r.black.accuracy);
    assert.strictEqual(r.black.accuracy, 100);
  });
});
