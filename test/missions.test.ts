import assert from "assert";
import { claimable, dayKey, periodEnds, weekKey } from "../src/missions.js";

describe("missions", () => {
  it("counts days and weeks in Algeria time (UTC+1), weeks starting Monday", () => {
    // Sunday 23:30 UTC = Monday 00:30 in Algiers: a new day and a new week there.
    const t = Date.UTC(2026, 8, 27, 23, 30);
    assert.strictEqual(dayKey(t), "d-2026-09-28");
    assert.strictEqual(weekKey(t), "w-2026-09-28");
    // Sunday 22:30 UTC = Sunday 23:30 in Algiers: still last week.
    const s = Date.UTC(2026, 8, 27, 22, 30);
    assert.strictEqual(dayKey(s), "d-2026-09-27");
    assert.strictEqual(weekKey(s), "w-2026-09-21");
    assert.strictEqual(periodEnds(s).day, Date.UTC(2026, 8, 27, 23, 0)); // Algiers midnight
    assert.strictEqual(periodEnds(s).week, Date.UTC(2026, 8, 27, 23, 0)); // …which is also Monday
  });

  it("lets a mission be claimed once, when done; the daily bonus needs every daily one claimed", () => {
    assert.ok(!claimable("d_win1", { wins: 0 }));
    assert.ok(claimable("d_win1", { wins: 1 }));
    assert.ok(!claimable("d_win1", { wins: 3, claimed: { d_win1: true } }));
    assert.ok(!claimable("nope", { wins: 9 }));
    assert.ok(!claimable("d_all", { claimed: { d_play3: true, d_win1: true } }));
    assert.ok(claimable("d_all", { claimed: { d_play3: true, d_win1: true, d_survive1: true, d_minutes20: true } }));
  });
});
