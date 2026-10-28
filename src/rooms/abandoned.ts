import type { Client, Room } from "colyseus";

const ABANDONED_MS = 60_000;
const SPECTATOR_SECONDS = 120;

/**
 * A spectator's connection dropped (his app in the background, a network blip): his place is held two minutes, as
 * a player's seat is, so he comes back to the game he was watching. onLeave runs if he doesn't.
 */
export function holdSpectator(room: Room, client: Client) {
  holdSeat(room, client, SPECTATOR_SECONDS);
}

/**
 * Holds a dropped connection's place [seconds] (rejects when it runs out, on a kick…; onLeave then runs). A connection
 * that came back and dropped again before its app confirmed it is held too: Colyseus would refuse ("not joined") and
 * onLeave would run at once — a Werewolf player died "after 20 minutes" a few minutes in. Its token stays the same
 * across reconnects, so an app that never heard of a new one still gets back.
 */
export function holdSeat(room: Room, client: Client, seconds: number) {
  const c = client as any;
  if (c.cameBack) delete c._enqueuedMessages; // ponytail: Colyseus internals (0.18), check on an upgrade
  const token = client.reconnectionToken;
  const seat = room.allowReconnection(client, seconds);
  // (Straight on the Deferred: it runs before onReconnect and the JOIN_ROOM frame that carries the token.)
  seat.then((back: any) => {
    back.cameBack = true;
    back.reconnectionToken = token;
  }, () => {});
  return seat;
}

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
