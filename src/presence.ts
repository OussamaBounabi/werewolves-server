import { savePresence, type Where } from "./accounts.js";

/**
 * Who is online, and where: the game server knows, since the apps stay connected to it — to the presence
 * room while open, to a game room while playing (players and spectators). Saved to PocketBase (presence
 * for the friends lists, users.room for the chat rule) when it changes, one write at a time per player.
 */
const apps = new Map<string, number>(); // uid → his open connections to the presence room
const rooms = new Map<string, Map<string, string>>(); // uid → the rooms he's in (roomId → game), latest last
const saved = new Map<string, string>(); // uid → what PocketBase has
const writes = new Map<string, Promise<void>>();

/** His app connected to the presence room. */
export function appOpened(uid: string) {
  apps.set(uid, (apps.get(uid) ?? 0) + 1);
  changed(uid);
}

/** His app left the presence room (closed, or offline for longer than its reconnection time). */
export function appClosed(uid: string) {
  const open = (apps.get(uid) ?? 1) - 1;
  if (open > 0) apps.set(uid, open);
  else apps.delete(uid);
  changed(uid);
}

/** He joined a game room ([game] = its name: werewolf, rummy…), as a player or a spectator. */
export function enterRoom(uid: string, game: string, roomId: string) {
  const inRooms = rooms.get(uid) ?? new Map<string, string>();
  inRooms.delete(roomId);
  inRooms.set(roomId, game);
  rooms.set(uid, inRooms);
  changed(uid);
}

/** He left that room for good (he may already be in another). */
export function leaveRoom(uid: string, roomId: string) {
  const inRooms = rooms.get(uid);
  if (!inRooms?.delete(roomId)) return;
  if (inRooms.size === 0) rooms.delete(uid);
  changed(uid);
}

/** The rooms he is in now, as a player or a spectator. */
export const roomsOf = (uid: string) => [...(rooms.get(uid)?.keys() ?? [])];

/** How many people have the app open right now (in a game or not): the home screen shows it. */
export function onlineCount() {
  return new Set([...apps.keys(), ...rooms.keys()]).size;
}

/** In a game (the last room he joined), else online if his app is connected, else offline. */
export function whereIs(uid: string): Where {
  const inRooms = rooms.get(uid);
  if (inRooms?.size) {
    const [room, game] = [...inRooms].at(-1)!;
    return { state: "in_game", game, room };
  }
  return { state: apps.has(uid) ? "online" : "offline", game: "", room: "" };
}

function changed(uid: string) {
  const write = (writes.get(uid) ?? Promise.resolve())
    .then(async () => {
      const where = whereIs(uid); // (by now: several changes make one write)
      const key = JSON.stringify(where);
      if (saved.get(uid) === key) return;
      await savePresence(uid, where);
      if (where.state === "offline") saved.delete(uid);
      else saved.set(uid, key);
    })
    .catch((e) => console.error("saving presence failed", e));
  writes.set(uid, write);
  write.then(() => writes.get(uid) === write && writes.delete(uid));
}

/** Resolves once every presence change so far is saved (tests). */
export async function presenceSaved() {
  await Promise.all(writes.values());
}
