import type { Client, Room } from "colyseus";

/** The emojis a player can show over his avatar (the apps have their pictures under these names). */
export const EMOJIS = [
  "laugh", "joy", "tongue", "sob", "angry", "party", "shush", "think", "gg",
  "clap", "thumbsup", "crossed", "wave", "muscle", "thumbsdown", "eyes", "heart", "broken",
  "middle", "disappointed", "disgusted",
] as const;
const EMOJI_GAP_MS = 1_500; // one emoji at a time over an avatar
const CHAT_MAX = 200;
const HISTORY = 100; // the lines a newcomer gets

/** [id] may show [emoji] now: one the apps know, and not too soon after his last ([last]: when each one showed his). */
export function emojiAllowed(last: Map<string, number>, id: string, emoji: unknown): emoji is string {
  if (typeof emoji !== "string" || !(EMOJIS as readonly string[]).includes(emoji)) return false;
  const now = Date.now();
  if (now - (last.get(id) ?? 0) < EMOJI_GAP_MS) return false;
  last.set(id, now);
  return true;
}

type Face = { id: string; name: string; avatar: number; frame: number };
type Line = { from: string; name: string; avatar: number; frame: number; text: string; at: number };

/**
 * The chat of the card and board games. Everyone in the room writes (spectators too); the apps also pop each line
 * over its writer's avatar. A seated player's "typing" shows dots there while he writes, and his emojis show there.
 * [seatOf]: the seat behind a connection, if it has one; [idOf]: the id the room knows that connection by.
 */
export class TableTalk {
  private lines: Line[] = [];
  private emojiAt = new Map<string, number>();

  constructor(
    private room: Room,
    private seatOf: (client: Client) => Face | undefined,
    private idOf: (client: Client) => string,
  ) {
    room.onMessage("chat", (client, msg: { text?: unknown }) => this.chat(client, msg?.text));
    room.onMessage("typing", (client, msg: { on?: unknown }) => {
      const seat = this.seatOf(client);
      if (seat) room.broadcast("typing", { from: seat.id, on: msg?.on === true }, { except: client });
    });
    room.onMessage("emoji", (client, msg: { id?: unknown }) => {
      const seat = this.seatOf(client);
      const emoji = msg?.id;
      if (seat && emojiAllowed(this.emojiAt, seat.id, emoji)) room.broadcast("emoji", { from: seat.id, id: emoji });
    });
  }

  /** The chat so far, for a newcomer (or an app coming back). */
  history(client: Client) {
    client.send("chat_history", this.lines);
  }

  private chat(client: Client, text: unknown) {
    const clean = typeof text === "string" ? text.trim().slice(0, CHAT_MAX) : "";
    if (!clean || client.auth?.admin) return; // (the admin app only watches)
    const seat = this.seatOf(client);
    const account = client.auth?.account;
    const face: Face = seat
      ? { id: seat.id, name: seat.name, avatar: seat.avatar, frame: seat.frame }
      : { id: this.idOf(client), name: account?.name ?? "spectator", avatar: account?.avatar ?? 0, frame: account?.frame ?? 0 };
    const line: Line = { from: face.id, name: face.name, avatar: face.avatar, frame: face.frame, text: clean, at: Date.now() };
    this.lines.push(line);
    if (this.lines.length > HISTORY) this.lines.shift();
    this.room.broadcast("chat", line);
  }
}
