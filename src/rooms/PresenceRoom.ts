import { Room, Client, ServerError } from "colyseus";
import { accountFor, accountsEnabled, BanError } from "../accounts.js";
import { appClosed, appOpened } from "../presence.js";
import { seen } from "../metrics.js";
import { holdSeat } from "./abandoned.js";

const RECONNECT_SECONDS = 30; // a network blip doesn't show him offline
let presence: PresenceRoom | null = null; // (one room holds every app)

/** A player just banned: his app is put out of the presence room, finds the ban as it joins again, and says so. */
export function kickFromApp(uid: string) {
  for (const client of presence?.clients ?? []) if (client.auth?.uid === uid) client.leave(4403);
}

/**
 * The app stays in this room while it's open — joinOrCreate("presence", { idToken }) — which is how the
 * server knows its player is online (presence.ts). No state, no messages. Signed-in players only.
 */
export class PresenceRoom extends Room {
  maxClients = 5000;

  async onAuth(_client: Client, options: { idToken?: string } = {}): Promise<{ uid: string }> {
    if (!accountsEnabled || !options.idToken) throw new ServerError(4401, "auth");
    try {
      return { uid: (await accountFor(String(options.idToken))).uid };
    } catch (e) {
      throw e instanceof BanError ? new ServerError(4403, "banned") : new ServerError(4401, "auth");
    }
  }

  onCreate() {
    presence = this;
  }

  onDispose() {
    if (presence === this) presence = null;
  }

  onJoin(client: Client) {
    appOpened(client.auth.uid);
    seen(client.auth.uid); // one of today's active players
  }

  onDrop(client: Client) {
    holdSeat(this, client, RECONNECT_SECONDS);
  }

  onLeave(client: Client) {
    appClosed(client.auth.uid);
  }
}
