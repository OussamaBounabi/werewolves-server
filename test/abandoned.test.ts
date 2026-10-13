import assert from "assert";

import { Abandon } from "../src/rooms/abandoned.js";

/** A room as Abandon sees it: who is connected, and a clock whose timers the test fires by hand. */
function fakeRoom(clients: number) {
  const timers: { run: () => void; cleared: boolean; clear(): void }[] = [];
  const room = {
    clients: { length: clients },
    closed: 0,
    clock: {
      setTimeout(run: () => void, ms: number) {
        assert.strictEqual(ms, 60_000);
        const timer = { run, cleared: false, clear: (): void => void (timer.cleared = true) };
        timers.push(timer);
        return timer;
      },
    },
    disconnect: async (): Promise<void> => void room.closed++,
  };
  const waiting = () => timers.filter((t) => !t.cleared);
  return { room, waiting, fire: () => waiting().forEach((t) => t.run()) };
}
const human = { connected: true };
const dropped = { connected: false };
const bot = { connected: true, bot: "normal" };

describe("a room nobody plays in", () => {
  it("closes a minute after its last player's app is gone, unless one comes back", () => {
    const { room, waiting, fire } = fakeRoom(0);
    const abandon = new Abandon(room as any);
    abandon.check([]); // just created: its host isn't in yet
    abandon.check([human, bot]);
    assert.strictEqual(waiting().length, 0);
    abandon.check([dropped, bot]); // everyone's app is gone: a minute starts
    assert.strictEqual(waiting().length, 1);
    abandon.check([human, bot]); // he's back
    assert.strictEqual(waiting().length, 0);
    abandon.check([dropped, dropped]);
    abandon.check([dropped, dropped]); // (still one minute, not two)
    assert.strictEqual(waiting().length, 1);
    assert.strictEqual(room.closed, 0);
    fire();
    assert.strictEqual(room.closed, 1);
    assert.strictEqual(abandon.closing, true);
  });

  it("closes a minute after only bots are left, and at once when no seat is", () => {
    const bots = fakeRoom(1); // someone is watching
    const table = new Abandon(bots.room as any);
    table.check([human, bot]);
    table.check([bot, { connected: true, bot: "hard" }, { connected: false, left: true }, { connected: true, quit: true }]);
    assert.strictEqual(bots.room.closed, 0);
    bots.fire();
    assert.strictEqual(bots.room.closed, 1);

    const watched = fakeRoom(2);
    const lobby = new Abandon(watched.room as any);
    lobby.check([human]);
    lobby.check([]); // the last seat is gone: the two watching are sent home
    assert.strictEqual(watched.room.closed, 1);
    lobby.check([]);
    assert.strictEqual(watched.room.closed, 1); // once
  });
});
