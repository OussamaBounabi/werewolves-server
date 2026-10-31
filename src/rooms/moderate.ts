import { matchMaker, type Client, type Room } from "colyseus";
import { muteVoice, voiceMuted } from "../voice.js";

/**
 * What support does in a live room from the admin app: who is in it, close it, put someone out of it (and keep him
 * out while it lasts), mute him (no chat line, no mic) and write to the room as support. Every game's room already
 * has what this needs (its kicked players, removeBanned, its chat), reached here by name: they're private to each
 * room, which never calls these itself.
 */
export type ChatLine = { name: string; text: string; at: number; uid?: string };

type Moderated = Room & {
  banned?: Map<string, string> | Set<string>; // (Werewolf's is a set)
  removeBanned?(uid: string): void;
  idOf?(client: Client): string; // a table's id for a connection (Werewolf: its sessionId)
  seat?(id: string): unknown;
  talking?: boolean; // Mimic Party: whether the round lets the seated talk
  tableTalk?: { say(text: string): void; allLines(): ChatLine[] };
  adminSay?(text: string): void; // Werewolf's chat
  adminLines?(): ChatLine[];
};

const muted = new Map<string, Set<string>>(); // roomId → the uids support muted there

/** Support muted [uid] in this room: his chat lines go nowhere. */
export const isChatMuted = (roomId: string, uid: string | undefined) => !!uid && muted.get(roomId)?.has(uid) === true;

const roomById = (roomId: string) => matchMaker.getLocalRoomById(roomId) as unknown as Moderated | undefined;
const idIn = (room: Moderated, client: Client) => room.idOf?.(client) ?? client.sessionId;
const seated = (room: Moderated, id: string) => !!(room.seat?.(id) ?? (room.state as any)?.players?.has?.(id));

/** A room's chat as it is now (the last 100 lines of each table; Werewolf's day, night and graveyard). */
export function chatLines(roomId: string): ChatLine[] {
  const room = roomById(roomId);
  return room?.tableTalk?.allLines() ?? room?.adminLines?.() ?? [];
}

/** Who is in a room now (players and people watching, by account), whether support muted them, and its chat. */
export function roomPeople(roomId: string) {
  const room = roomById(roomId);
  if (!room) throw new Error("this room is gone");
  const people = new Map<string, Record<string, unknown>>();
  for (const c of room.clients) {
    const a = c.auth?.account;
    if (!a?.uid || people.has(a.uid)) continue;
    const id = idIn(room, c);
    people.set(a.uid, {
      uid: a.uid, name: a.name, avatar: a.avatar ?? 0, frame: a.frame ?? 0, seated: seated(room, id),
      muted: isChatMuted(roomId, a.uid) || voiceMuted(roomId, id),
    });
  }
  return { people: [...people.values()], canSay: !!(room.tableTalk || room.adminSay), lines: chatLines(roomId).slice(-60) };
}

/** Support's action in a room: "close", "kick" / "mute" / "unmute" [uid], "say" [text]. */
export async function moderate(roomId: string, action: string, uid = "", text = "") {
  const room = roomById(roomId);
  if (!room) throw new Error("this room is gone");
  const his = room.clients.filter((c) => uid && c.auth?.account?.uid === uid);
  switch (action) {
    case "close":
      room.broadcast("admin_notice", { kind: "closed" });
      room.clock.setTimeout((): void => void room.disconnect().catch((): void => {}), 300); // (the notice first; a staked pot goes back)
      return;
    case "kick":
      if (!uid) throw new Error("who");
      if (room.banned instanceof Map) room.banned.set(uid, "admin");
      else room.banned?.add(uid);
      for (const c of his) c.send("admin_notice", { kind: "kicked" });
      room.removeBanned?.(uid);
      return;
    case "mute":
    case "unmute": {
      if (!uid) throw new Error("who");
      const on = action === "mute";
      for (const id of muted.keys()) if (!roomById(id)) muted.delete(id); // (rooms gone since)
      const set = muted.get(roomId) ?? new Set<string>();
      if (on) set.add(uid);
      else set.delete(uid);
      muted.set(roomId, set);
      for (const c of his) {
        const id = idIn(room, c);
        // Unmuted, his mic is what his room gives him: a seat at a table (Mimic: when the round lets him); Werewolf
        // gives it back itself within a second.
        const talk = room.adminSay ? false : seated(room, id) && room.talking !== false;
        await muteVoice(roomId, id, on, talk);
        c.send("admin_notice", { kind: on ? "muted" : "unmuted" });
      }
      return;
    }
    case "say": {
      const line = text.trim().slice(0, 200);
      if (!line) throw new Error("empty");
      if (room.tableTalk) room.tableTalk.say(line);
      else if (room.adminSay) room.adminSay(line);
      else throw new Error("this game has no chat");
      return;
    }
    default:
      throw new Error("action");
  }
}
