import type { Client, Room } from "colyseus";
import { vipLevel } from "../accounts.js";
import { emojisOpen } from "./perks.js";
import { isChatMuted } from "./moderate.js";

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

type Face = { id: string; name: string; avatar: number; frame: number; vip?: string };
type Line = { from: string; name: string; avatar: number; frame: number; vip: string; text: string; at: number; uid: string };

/**
 * The chat of the card and board games. Everyone in the room writes (spectators too); the apps also pop each line
 * over its writer's avatar. A seated player's "typing" shows dots there while he writes, and his emojis show there.
 * [seatOf]: the seat behind a connection, if it has one; [idOf]: the id the room knows that connection by.
 * [channelOf]: the table a connection is at, when a room has several (billiard's cup): each its own chat.
 */
export class TableTalk {
  private channels = new Map<string, Line[]>(); // each table's lines ("" the room's own)
  private emojiAt = new Map<string, number>();

  constructor(
    private room: Room,
    private seatOf: (client: Client) => Face | undefined,
    private idOf: (client: Client) => string,
    private channelOf: (client: Client) => string = () => "",
  ) {
    room.onMessage("chat", (client, msg: { text?: unknown }) => this.chat(client, msg?.text));
    room.onMessage("typing", (client, msg: { on?: unknown }) => {
      const seat = this.seatOf(client);
      if (seat) this.tell(client, "typing", { from: seat.id, on: msg?.on === true }, true);
    });
    room.onMessage("emoji", (client, msg: { id?: unknown }) => {
      const seat = this.seatOf(client);
      const emoji = msg?.id;
      if (seat && emojisOpen(!!seat.vip) && emojiAllowed(this.emojiAt, seat.id, emoji)) {
        this.tell(client, "emoji", { from: seat.id, id: emoji });
      }
    });
  }

  /** The room's lines (a room of one table: all of them). */
  get lines() {
    return this.channels.get("") ?? [];
  }

  /** Every table's lines (the admin app's view of the room; a report's snapshot). */
  allLines() {
    return [...this.channels.values()].flat().sort((a, b) => a.at - b.at).map((l) => ({ name: l.name, text: l.text, at: l.at, uid: l.uid }));
  }

  /** A line from support, to every table. */
  say(text: string) {
    const line: Line = { from: "admin", name: "PlayRoom", avatar: 0, frame: 0, vip: "admin", text, at: Date.now(), uid: "" };
    const channels = new Set(["", ...this.channels.keys(), ...this.room.clients.map((c) => this.channelOf(c))]);
    for (const channel of channels) {
      const lines = this.channels.get(channel) ?? [];
      this.channels.set(channel, lines);
      lines.push(line);
      if (lines.length > HISTORY) lines.shift();
    }
    this.room.broadcast("chat", line);
  }

  /** The chat so far, for a newcomer (or an app coming back, or one gone to another table). */
  history(client: Client) {
    client.send("chat_history", this.channels.get(this.channelOf(client)) ?? []);
  }

  /** To everyone at [from]'s table (but him, [except]). */
  private tell(from: Client, type: string, msg: unknown, except = false) {
    const channel = this.channelOf(from);
    for (const c of this.room.clients) if ((!except || c !== from) && this.channelOf(c) === channel) c.send(type, msg);
  }

  private chat(client: Client, text: unknown) {
    const clean = typeof text === "string" ? text.trim().slice(0, CHAT_MAX) : "";
    if (!clean || client.auth?.admin) return; // (the admin app writes through support's "say")
    if (isChatMuted(this.room.roomId, client.auth?.account?.uid)) return client.send("error", { code: "admin_muted" });
    const seat = this.seatOf(client);
    const account = client.auth?.account;
    const face: Face = seat
      ? { id: seat.id, name: seat.name, avatar: seat.avatar, frame: seat.frame, vip: seat.vip }
      : { id: this.idOf(client), name: account?.name ?? "spectator", avatar: account?.avatar ?? 0, frame: account?.frame ?? 0, vip: vipLevel(account) };
    const line: Line = {
      from: face.id, name: face.name, avatar: face.avatar, frame: face.frame, vip: face.vip ?? "", text: clean, at: Date.now(),
      uid: account?.uid ?? "",
    };
    const channel = this.channelOf(client);
    const lines = this.channels.get(channel) ?? [];
    this.channels.set(channel, lines);
    lines.push(line);
    if (lines.length > HISTORY) lines.shift();
    this.tell(client, "chat", line);
  }
}
