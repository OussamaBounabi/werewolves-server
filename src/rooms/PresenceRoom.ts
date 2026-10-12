import { Room, Client, ServerError } from "colyseus";
import { accountFor, accountsEnabled } from "../accounts.js";
import { appClosed, appOpened } from "../presence.js";

const RECONNECT_SECONDS = 30; // a network blip doesn't show him offline

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
    } catch {
      throw new ServerError(4401, "auth");
    }
  }

  onJoin(client: Client) {
    appOpened(client.auth.uid);
  }

  onDrop(client: Client) {
    Promise.resolve(this.allowReconnection(client, RECONNECT_SECONDS)).catch(() => {});
  }

  onLeave(client: Client) {
    appClosed(client.auth.uid);
  }
}
