import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

/**
 * In-room voice on LiveKit (LiveKit Cloud while developing, our own LiveKit server later: only the
 * three .env values change). The game server decides who may talk and who may hear, per phase;
 * LiveKit enforces it, so a modified app can't listen in at night.
 */
try {
  process.loadEnvFile(); // .env next to package.json (git-ignored)
} catch {}

const url = process.env.LIVEKIT_URL ?? "";
const key = process.env.LIVEKIT_API_KEY ?? "";
const secret = process.env.LIVEKIT_API_SECRET ?? "";
const testing = process.env.NODE_ENV === "test" || process.argv.some((arg) => arg.includes("mocha"));
export const voiceEnabled = !!(url && key && secret) && !testing;

const rooms = voiceEnabled ? new RoomServiceClient(url.replace(/^ws/, "http"), key, secret) : null;

export type VoiceRights = { talk: boolean; hear: boolean };

/** Each game room has two voice rooms: the living one, and the graveyard for the dead and spectators. */
const voiceRoom = (roomId: string, grave = false) => `werewolf-${roomId}${grave ? "-grave" : ""}`;

/** A token to join the room's voice, with the rights of the moment. [identity] = the game sessionId. */
export async function voiceToken(roomId: string, identity: string, name: string, rights: VoiceRights, grave = false) {
  const token = new AccessToken(key, secret, { identity, name, ttl: "4h" });
  token.addGrant({
    room: voiceRoom(roomId, grave),
    roomJoin: true,
    canPublish: rights.talk,
    canSubscribe: rights.hear,
    canPublishData: false,
  });
  return { url, token: await token.toJwt() };
}

/** Changes a connected player's rights (the phase changed, he died…). Not connected yet: nothing to do. */
export async function setVoiceRights(roomId: string, identity: string, rights: VoiceRights) {
  await rooms?.updateParticipant(voiceRoom(roomId), identity, {
    permission: { canPublish: rights.talk, canSubscribe: rights.hear, canPublishData: false },
  });
}

/** He left the game room: out of its voice too (a modified app can't stay and listen). */
export async function dropFromVoice(roomId: string, identity: string) {
  await rooms?.removeParticipant(voiceRoom(roomId), identity);
}

export async function closeVoice(roomId: string, { graveOnly = false } = {}) {
  await rooms?.deleteRoom(voiceRoom(roomId, true)).catch(() => {});
  if (!graveOnly) await rooms?.deleteRoom(voiceRoom(roomId));
}
