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
 * server knows its player is online (presence.ts). No state. Signed-in players only.
 *
 * "chat" { to, typing, here }: passed on to that player's apps as { from, typing, here } — he's writing to him, he
 * has their conversation open (the Chat tab's "typing…" and the avatar peeking in). Nothing kept, nothing checked
 * but its shape: an app shows it only for a friend's open conversation.
 */
export class PresenceRoom extends Room {
  maxClients = 5000;
  private sent = new Map<string, number[]>(); // each app's last chat signals: at most 4 a second

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
    this.onMessage("chat", (client, data: { to?: unknown; typing?: unknown; here?: unknown }) => {
      const to = data?.to;
      if (typeof to !== "string" || !to || to.length > 40) return;
      const now = Date.now(), recent = (this.sent.get(client.sessionId) ?? []).filter((t) => now - t < 1000);
      if (recent.length >= 4) return;
      this.sent.set(client.sessionId, [...recent, now]);
      const signal = { from: client.auth.uid, typing: data.typing === true, here: data.here === true };
      // ponytail: one pass over every app in the room per signal; an index by uid if the room grows to thousands
      for (const other of this.clients) if (other.auth?.uid === to) other.send("chat", signal);
    });
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
    this.sent.delete(client.sessionId);
    appClosed(client.auth.uid);
  }
}
