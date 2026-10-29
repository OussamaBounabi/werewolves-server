import { Room, Client, ServerError } from "colyseus";
import { accountFor, accountsEnabled, type Account } from "../accounts.js";
import { clanOf } from "../clans.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { holdSeat } from "./abandoned.js";

/**
 * A clan's voice lounge, always there for its members: joinOrCreate("clan_lounge", { idToken, clan }), one room per
 * clan (members only). Eight seats talk; everyone else in it listens. A member sits on a free seat and leaves it; raises
 * his hand (asking for a seat); sends an emoji everyone sees float up. It ends by itself once nobody is in it (its
 * voice with it). State to everyone as "lounge": the seats, who listens, the raised hands. Voice identity: the
 * session id.
 */
export const LOUNGE_SEATS = 8;
const RECONNECT_SECONDS = 30;
const EMOJIS = ["👏", "😂", "🔥", "❤️", "👋", "😮", "🎉", "👍"];

type Person = { id: string; uid: string; name: string; avatar: number; frame: number; vip: string };
type Auth = { account: Account };

export class ClanLoungeRoom extends Room {
  maxClients = 50;
  clan = "";
  seats: (string | null)[] = Array(LOUNGE_SEATS).fill(null); // session ids
  people = new Map<string, Person>(); // in the lounge, by session id
  hands = new Set<string>(); // session ids asking for a seat

  async onAuth(_client: Client, options: { idToken?: string; clan?: string; name?: string } = {}): Promise<Auth> {
    // Without accounts (the tests): anyone, by the name he gives, as at the game tables.
    if (!accountsEnabled) {
      const name = String(options.name ?? "?");
      return { account: { uid: name, name, avatar: 0, frame: 0, vip: false, vipPro: false, roleCardDay: "", roomLook: null } };
    }
    if (!options.idToken) throw new ServerError(4401, "auth");
    let account: Account;
    try {
      account = await accountFor(String(options.idToken));
    } catch {
      throw new ServerError(4401, "auth");
    }
    if (!options.clan || (await clanOf(account.uid)) !== options.clan) throw new ServerError(4403, "not in the clan");
    return { account };
  }

  onCreate(options: { clan?: string }) {
    this.clan = String(options.clan ?? "");
    this.onMessage("sit", (client, msg: { seat?: number }) => this.sit(client.sessionId, Number(msg?.seat)));
    this.onMessage("stand", (client) => this.stand(client.sessionId));
    this.onMessage("hand", (client) => {
      if (!this.hands.delete(client.sessionId)) this.hands.add(client.sessionId);
      this.sync();
    });
    this.onMessage("emoji", (client, msg: { emoji?: string }) => {
      if (EMOJIS.includes(String(msg?.emoji))) this.broadcast("lounge_emoji", { id: client.sessionId, emoji: msg.emoji });
    });
    this.onMessage("voice_join", (client) => this.voice(client));
    this.updateListing();
  }

  onJoin(client: Client, _options: unknown, auth: Auth) {
    const a = auth.account;
    this.people.set(client.sessionId, {
      id: client.sessionId, uid: a.uid, name: a.name, avatar: a.avatar, frame: a.frame, vip: a.vipPro ? "pro" : a.vip ? "vip" : "",
    });
    this.sync();
  }

  onDrop(client: Client) {
    holdSeat(this, client, RECONNECT_SECONDS);
  }

  onLeave(client: Client) {
    const at = this.seats.indexOf(client.sessionId);
    if (at >= 0) this.seats[at] = null;
    this.people.delete(client.sessionId);
    this.hands.delete(client.sessionId);
    if (voiceEnabled) dropFromVoice(this.roomId, client.sessionId).catch(() => {});
    this.sync();
  }

  onDispose() {
    if (voiceEnabled) closeVoice(this.roomId).catch(() => {});
  }

  private async voice(client: Client) {
    if (!voiceEnabled) return client.send("voice", { enabled: false });
    const p = this.people.get(client.sessionId);
    const talk = this.seats.includes(client.sessionId);
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, p?.name ?? "?", { talk, hear: true })) });
  }

  private sit(id: string, seat: number) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= LOUNGE_SEATS || this.seats[seat] !== null || !this.people.has(id)) return;
    const was = this.seats.indexOf(id);
    if (was >= 0) this.seats[was] = null;
    this.seats[seat] = id;
    this.hands.delete(id);
    if (voiceEnabled) setVoiceRights(this.roomId, id, { talk: true, hear: true }).catch(() => {});
    this.sync();
  }

  private stand(id: string) {
    const at = this.seats.indexOf(id);
    if (at < 0) return;
    this.seats[at] = null;
    if (voiceEnabled) setVoiceRights(this.roomId, id, { talk: false, hear: true }).catch(() => {});
    this.sync();
  }

  /** Who sits where and who listens, to everyone; the clan page's door reads the same from the listing. */
  sync() {
    const face = (id: string) => this.people.get(id)!;
    const seats = this.seats.map((id) => (id && this.people.has(id) ? face(id) : null));
    const listeners = [...this.people.values()].filter((p) => !this.seats.includes(p.id));
    this.broadcast("lounge", { seats, listeners, hands: [...this.hands] });
    this.updateListing();
  }

  private updateListing() {
    this.setMetadata({
      clan: this.clan,
      talking: this.seats.flatMap((id) => (id && this.people.has(id) ? [{ name: this.people.get(id)!.name, avatar: this.people.get(id)!.avatar }] : [])),
      listeners: [...this.people.keys()].filter((id) => !this.seats.includes(id)).length,
    }).catch(() => {});
  }
}
