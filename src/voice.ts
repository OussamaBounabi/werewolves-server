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

// The apps join at LIVEKIT_URL (the public address). The game server's own calls can go straight to the voice server
// on its machine instead (LIVEKIT_API_URL, e.g. http://127.0.0.1:7880): no name to look up, no proxy in between.
const api = process.env.LIVEKIT_API_URL || url.replace(/^ws/, "http");
const rooms = voiceEnabled ? new RoomServiceClient(api, key, secret) : null;

export type VoiceRights = { talk: boolean; hear: boolean };

/** The players support muted, by room ("<roomId>/<identity>"): whatever their room grants, no mic. */
const muted = new Set<string>();
const mic = (roomId: string, identity: string, talk: boolean) => talk && !muted.has(`${roomId}/${identity}`);

/** Support mutes (or unmutes) a player in a room's voice: [talk], what his room lets him do once unmuted. */
export async function muteVoice(roomId: string, identity: string, on: boolean, talk: boolean) {
  if (on) muted.add(`${roomId}/${identity}`);
  else muted.delete(`${roomId}/${identity}`);
  if (on || talk) await setVoiceRights(roomId, identity, { talk: !on && talk, hear: true }).catch(() => {});
}

export const voiceMuted = (roomId: string, identity: string) => muted.has(`${roomId}/${identity}`);

/** Nothing: what an access to a werewolf voice room carries (the room grants the rights of the moment once he's in). */
export const NO_VOICE: VoiceRights = { talk: false, hear: false };

/** Each game room has two voice rooms: the living one, and the graveyard for the dead and spectators. */
const voiceRoom = (roomId: string, grave = false) => `werewolf-${roomId}${grave ? "-grave" : ""}`;

/** A token to join the room's voice, with the rights of the moment. [identity] = the game sessionId. */
export async function voiceToken(
  roomId: string,
  identity: string,
  name: string,
  rights: VoiceRights,
  grave = false,
  hidden = false, // an admin listening: invisible to the other participants
) {
  const token = new AccessToken(key, secret, { identity, name, ttl: "4h" });
  token.addGrant({
    room: voiceRoom(roomId, grave),
    roomJoin: true,
    canPublish: mic(roomId, identity, rights.talk),
    canSubscribe: rights.hear,
    canPublishData: false,
    hidden,
  });
  return { url, token: await token.toJwt() };
}

/**
 * Runs [send] until it goes through: [tries] times at most, [waitMs] apart, and only while [wanted] still holds (a
 * newer change may have replaced this one). "Does not exist" is an answer, not a failure: the player isn't in the
 * voice room, and the token he joins with carries his rights.
 */
export async function insist(send: () => Promise<unknown>, wanted: () => boolean, tries = 5, waitMs = 1000) {
  for (let attempt = 1; wanted(); attempt++) {
    try {
      await send();
      return;
    } catch (e) {
      const why = String((e as Error)?.message ?? e);
      if (/does not exist|not found/i.test(why)) return;
      if (attempt >= tries) return console.warn(`voice: a change was lost after ${tries} tries (${why.slice(0, 160)})`);
      if (attempt === 1) console.warn(`voice: the voice server didn't take a change (${why.slice(0, 160)}): trying again`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** The last rights asked for each player of a voice room: a change still being tried again gives way to a newer one. */
const wantedRights = new Map<string, VoiceRights>();

/**
 * Changes a connected player's rights (the phase changed, he died…). Not connected yet: nothing to do. A change the
 * voice server didn't take is sent again: lost, it leaves a player without his mic and without sound until he
 * relaunches his app.
 */
export async function setVoiceRights(roomId: string, identity: string, rights: VoiceRights) {
  if (!rooms) return;
  const player = `${roomId}/${identity}`;
  wantedRights.set(player, rights);
  const permission = { canPublish: mic(roomId, identity, rights.talk), canSubscribe: rights.hear, canPublishData: false };
  await insist(() => rooms.updateParticipant(voiceRoom(roomId), identity, { permission }), () => wantedRights.get(player) === rights);
  if (wantedRights.get(player) === rights) wantedRights.delete(player);
}

/** He left the game room: out of its voice too (a modified app can't stay and listen). */
export async function dropFromVoice(roomId: string, identity: string, grave = false) {
  await rooms?.removeParticipant(voiceRoom(roomId, grave), identity);
}

/** Who is in a game's voice room now, and what the voice server lets each of them do. */
export async function voiceParticipants(roomId: string, grave = false) {
  if (!rooms) return [];
  return (await rooms.listParticipants(voiceRoom(roomId, grave))).map((p) => ({
    identity: p.identity,
    talk: !!p.permission?.canPublish,
    hear: !!p.permission?.canSubscribe,
  }));
}

/** One participant's rights, set now (no retries: the werewolf room checks its voice rooms again every second). */
export async function grantVoice(roomId: string, identity: string, rights: VoiceRights, { grave = false, hidden = false } = {}) {
  const permission = { canPublish: mic(roomId, identity, rights.talk), canSubscribe: rights.hear, canPublishData: false, hidden };
  await rooms?.updateParticipant(voiceRoom(roomId, grave), identity, { permission });
}

export async function closeVoice(roomId: string, { graveOnly = false } = {}) {
  await rooms?.deleteRoom(voiceRoom(roomId, true)).catch(() => {});
  if (!graveOnly) await rooms?.deleteRoom(voiceRoom(roomId));
}
