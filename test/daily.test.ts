import assert from "assert";
import { dailyNext, dailyTaken, freeSpins, spin, WHEEL } from "../src/daily.js";

const at = (d: number, h = 12) => Date.UTC(2026, 9, d, h); // October 2026, noon in Algiers

describe("daily reward and lucky wheel", () => {
  it("a day of seven a day: a missed day starts again, after the seventh the first", () => {
    assert.strictEqual(dailyNext(null, at(1)), 1);
    let d = dailyTaken(null, at(1));
    assert.deepStrictEqual(d, { day: 1, at: "d-2026-10-01", streak: 1 });
    assert.strictEqual(dailyNext(d, at(1, 20)), null); // taken today
    for (let day = 2; day <= 7; day++) d = dailyTaken(d, at(day));
    assert.deepStrictEqual([d.day, d.streak], [7, 7]);
    d = dailyTaken(d, at(8));
    assert.deepStrictEqual([d.day, d.streak], [1, 8]); // the week again, still in a row
    assert.strictEqual(dailyNext(d, at(10)), 1); // missed the 9th
    assert.strictEqual(dailyTaken(d, at(10)).streak, 1);
    // 23:30 UTC is already the next day in Algiers.
    assert.strictEqual(dailyNext({ day: 3, at: "d-2026-10-01" }, Date.UTC(2026, 9, 1, 23, 30)), 4);
  });

  it("one free spin a day, two for a VIP; never a prize he owns", () => {
    assert.strictEqual(freeSpins(null, false, at(1)), 1);
    assert.strictEqual(freeSpins({ day: "d-2026-10-01", used: 1 }, false, at(1)), 0);
    assert.strictEqual(freeSpins({ day: "d-2026-10-01", used: 1 }, true, at(1)), 1);
    assert.strictEqual(freeSpins({ day: "d-2026-10-01", used: 5 }, false, at(2)), 1); // a new day
    const avatar = WHEEL.findIndex((p) => p.kind === "avatar"), frame = WHEEL.findIndex((p) => p.kind === "frame");
    assert.strictEqual(spin({ avatars: [], frames: [] }, 0.9999), avatar); // the last slice
    const owned = { avatars: [404], frames: [1] };
    for (let r = 0; r < 1; r += 0.001) assert.ok(![avatar, frame].includes(spin(owned, r)));
    assert.strictEqual(spin({ avatars: [], frames: [] }, 0), 0);
  });
});
