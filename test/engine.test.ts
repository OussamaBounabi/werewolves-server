import assert from "node:assert";
import { fen, startPos } from "../src/chess.js";
import { engineAvailable, engineEval, engineMove, setEngineCommand, stopEngine } from "../src/engine.js";

/** Against the pretend engine (test/fake-stockfish.ts): the UCI talk, one job after another, a restart after a crash. */
describe("engine", () => {
  before(() => setEngineCommand(["node", "--import", "tsx", "test/fake-stockfish.ts"]));
  after(() => setEngineCommand(null));

  it("plays a move at a rating and reads its lines, one job at a time", async function () {
    this.timeout(30_000);
    assert.ok(engineAvailable());
    const start = fen(startPos());
    const [move, view, again] = await Promise.all([engineMove(start, 1500, 100), engineEval(start, 100), engineMove(start, 3190, 100)]);
    assert.match(move!, /^[a-h][1-8][a-h][1-8]$/);
    assert.deepStrictEqual(view, { depth: 7, lines: [{ cp: 25, pv: [move] }] });
    assert.strictEqual(again, move);
    stopEngine(); // (as if it crashed: the next job starts a new one)
    assert.strictEqual(await engineMove(start, 2000, 100), move);
  });

  it("none set: not available, and asking fails", async () => {
    setEngineCommand(null);
    assert.ok(!engineAvailable());
    await assert.rejects(engineMove(fen(startPos()), 1500));
    setEngineCommand(["node", "--import", "tsx", "test/fake-stockfish.ts"]);
  });
});
