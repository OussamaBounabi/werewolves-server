import type { Room } from "colyseus";

const ABANDONED_MS = 60_000;

/** A seat as every table keeps it: whose app is here, and who isn't a person any more (a bot, or gone for good). */
type Seat = { connected: boolean; bot?: unknown; left?: boolean; quit?: boolean };

/**
 * Closes a table nobody plays at any more. Each room calls check() whenever its seats or connections change.
 * - No seat left (only people watching): closed at once.
 * - Only bots, and players whose app is gone: closed a minute later, unless one of them comes back first.
 * [close]: how this room ends (by default, everyone is disconnected and it's disposed of).
 */
export class Abandon {
  closing = false; // on its way out: the room's leave handlers must not play on (no bot takes a seat, no result)
  private timer: { clear(): void } | null = null;
  private seated = false; // a room is born empty, before its host arrives

  constructor(
    private room: Room,
    private close: () => void = () => void room.disconnect().catch(() => {}),
  ) {}

  check(seats: Iterable<Seat>) {
    if (this.closing) return;
    const all = [...seats];
    this.seated ||= all.length > 0;
    if (!this.seated || all.some((s) => s.connected && !s.bot && !s.left && !s.quit)) {
      this.timer?.clear();
      this.timer = null;
      return;
    }
    if (all.length === 0) {
      if (this.room.clients.length > 0) this.end(); // (with nobody connected at all, the server disposes of it itself)
      return;
    }
    this.timer ??= this.room.clock.setTimeout(() => this.end(), ABANDONED_MS);
  }

  private end() {
    this.closing = true;
    this.close();
  }
}
