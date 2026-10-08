import { Room, Client, ServerError } from "colyseus";
import { randomBytes } from "node:crypto";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, firebaseEnabled, isFriendOfAny, setRoom, type Account } from "../firebase.js";
import { MIMIC_SOUNDS } from "../mimicSounds.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";

/**
 * Mimic Party: each round everyone hears a well-known sound (a cow, a siren, a sneeze…) at the same moment, then
 * imitates it — as many takes as they like until the shared timer runs out (or everyone is done); each phone
 * scores its own take out of 100 (the shape of the sound: its rhythm, its melody, its brightness) and sends it
 * with its score over HTTP (/api/mimic/clip): the last one counts. Then the results: every take is played to
 * everyone and its score shown, one after the other, lowest first; then a moment to hear them again, and the
 * next sound when everyone taps "next" (or after it). The winner has the best average.
 *
 * No schema: everyone gets the "mimic" message after every change.
 */
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; roomType: string; started: boolean;
  players: number; maxPlayers: number; spectators: number;
};
type Settings = { roomType?: string; rounds?: number; category?: string };
type JoinOptions = Settings & { name?: string; playerId?: string; idToken?: string };
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number;
  connected: boolean;
  left: boolean;
  token: string; // for his takes' uploads
  scores: number[]; // each round's
  score: number; // this round's take's (-1 none)
  ms: number; // its length
  takes: number; // takes received this round
  done: boolean; // finished imitating this round
  ready: boolean; // tapped "next sound"
};
type Phase = "lobby" | "listen" | "record" | "judge" | "after" | "result";

const ROOM_TYPES = ["public", "friends", "private"];
const ROUNDS = [5, 10, 15];
const CATEGORIES = [...new Set(MIMIC_SOUNDS.map((s) => s.cat))];
const MAX_SEATS = 12;
const LEAD_MS = 800; // the sound starts this long after the phase, everywhere at once
const AFTER_SOUND_MS = 1_500;
const RECORD_MS = 30_000; // everyone's time to imitate, besides the sound's length
const TAKE_LEAD_MS = 1_200; // in the results, before each take plays
const SCORE_MS = 2_800; // its score shown, before the next one
const AFTER_MS = 30_000; // to hear the takes again; then the next sound anyway
const MAX_CLIP_BYTES = 400_000;
const PCM_BYTES_PER_MS = 32; // 16 kHz, 16-bit mono
const RECONNECT_SECONDS = 600;

export class MimicRoom extends Room<{ metadata: Meta }> {
  static pace = 1; // tests: every timer shorter
  maxClients = MAX_SEATS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private rounds = 10;
  private category = "random";
  private seats: Seat[] = [];
  private members = new Map<string, string>();
  private invited = new Set<string>();
  private round = 0;
  private deck: string[] = []; // the sounds still to come
  private sound = "";
  private playAt = 0; // when the sound plays, server time
  private endsAt = 0;
  private order: string[] = []; // the results: whose take plays, lowest score first
  private judged = -1; // the take playing now (index in order)
  private takeAt = 0; // when it plays
  private scoreAt = 0; // when its score shows
  private clips = new Map<string, Buffer>(); // this round's takes, by seat
  private timer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => void) =>
      this.onMessage(type, (client, msg: T) => {
        handler(client, msg ?? ({} as T));
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on("start_game", (c) => this.handleStart(c));
    on("done", (c) => this.handleDone(c.sessionId));
    on("next", (c) => this.handleNext(c.sessionId));
    on("play_again", (c) => this.handlePlayAgain(c));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (this.seat(client.sessionId) && typeof msg?.uid === "string") this.invited.add(msg.uid);
    });
    this.updateListing();
  }

  // ---- joining (as at the other tables) ----

  async onAuth(_client: Client, options: JoinOptions = {}): Promise<{ account: Account | null }> {
    let account: Account | null = null;
    if (options.idToken && firebaseEnabled) {
      try {
        account = await accountFor(String(options.idToken));
      } catch {
        throw new ServerError(4401, "auth");
      }
    }
    if (this.phase !== "lobby") throw new ServerError(4409, "started");
    if (this.seats.length >= MAX_SEATS) throw new ServerError(4409, "full");
    if (this.roomType !== "public" && this.seats.length > 0) {
      const ok =
        (account && this.invited.has(account.uid)) ||
        (this.roomType === "friends" && account && (await isFriendOfAny(account.uid, [...new Set(this.members.values())])));
      if (!ok) throw new ServerError(4410, this.roomType === "private" ? "private" : "friends");
    }
    return { account };
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const account: Account | null = client.auth?.account ?? null;
    const playerId = account?.uid ?? String(options.playerId ?? client.sessionId);
    const ghost = this.seats.find((s) => s.playerId === playerId);
    if (ghost) this.removeSeat(ghost.id);
    this.seats.push({
      id: client.sessionId,
      playerId,
      name: account?.name ?? (String(options.name ?? "").trim().slice(0, 24) || `Player-${client.sessionId.slice(0, 4)}`),
      uid: account?.uid ?? "",
      avatar: account?.avatar ?? randomAvatar(),
      frame: account?.frame ?? randomFrame(),
      connected: true,
      left: false,
      token: randomBytes(12).toString("hex"),
      scores: [],
      score: -1,
      ms: 0,
      takes: 0,
      done: false,
      ready: false,
    });
    if (account) {
      this.members.set(client.sessionId, account.uid);
      setRoom(account.uid, this.roomId).catch(() => {});
    }
    if (!this.hostId) this.hostId = client.sessionId;
    this.updateListing();
    this.sync();
  }

  onDrop(client: Client) {
    const seat = this.seat(client.sessionId);
    if (seat) seat.connected = false;
    Promise.resolve(this.allowReconnection(client, RECONNECT_SECONDS)).catch(() => {});
    this.checkAllDone();
    this.sync();
  }

  onReconnect(client: Client) {
    const seat = this.seat(client.sessionId);
    if (seat) seat.connected = true;
    this.sync();
  }

  onLeave(client: Client) {
    const id = client.sessionId;
    const uid = this.members.get(id);
    this.members.delete(id);
    if (uid) setRoom(uid, "", this.roomId).catch(() => {});
    if (voiceEnabled) dropFromVoice(this.roomId, id).catch(() => {});
    const seat = this.seat(id);
    if (this.phase === "lobby" || this.phase === "result") this.removeSeat(id);
    else if (seat) {
      Object.assign(seat, { left: true, connected: false, done: true, ready: true });
      this.checkAllDone();
    }
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.left && this.clients.getById(s.id))?.id ?? "";
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.timer?.clear();
    this.clips.clear();
    if (voiceEnabled) closeVoice(this.roomId).catch(() => {});
  }

  private async handleVoiceJoin(client: Client) {
    if (!voiceEnabled) return client.send("voice", { enabled: false });
    const name = this.seat(client.sessionId)?.name ?? "player";
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, name, { talk: this.talking, hear: true })) });
  }

  /** Mics off from the sound until the results are over (the takes stay clean and are heard clearly). */
  private talking = true;
  private talk(on: boolean) {
    if (this.talking === on) return;
    this.talking = on;
    if (!voiceEnabled) return;
    for (const s of this.seats) if (!s.left) setVoiceRights(this.roomId, s.id, { talk: on, hear: true }).catch(() => {});
  }

  // ---- the waiting room ----

  private applySettings(s: Settings) {
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (ROUNDS.includes(Number(s.rounds))) this.rounds = Number(s.rounds);
    if (s.category === "random" || CATEGORIES.includes(s.category as string)) this.category = s.category as string;
    this.updateListing();
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId) return;
    this.lock();
    for (const s of this.seats) s.scores = [];
    this.round = 0;
    this.deck = [];
    this.startRound();
  }

  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.seats.splice(index, 1);
    if (this.hostId === id) this.hostId = this.seats[0]?.id ?? "";
  }

  // ---- a round ----

  private seconds() {
    return MIMIC_SOUNDS.find((s) => s.id === this.sound)?.seconds ?? 3;
  }

  /** The next sound (no repeat until the category's are used up), heard by everyone at once. */
  private startRound() {
    this.round++;
    if (this.deck.length === 0) {
      this.deck = MIMIC_SOUNDS.filter((s) => this.category === "random" || s.cat === this.category)
        .map((s) => s.id)
        .sort(() => Math.random() - 0.5);
    }
    this.sound = this.deck.pop()!;
    for (const s of this.seats) Object.assign(s, { score: -1, ms: 0, takes: 0, done: s.left, ready: s.left });
    this.clips.clear(); // only this round's takes are kept
    this.order = [];
    this.judged = -1;
    this.phase = "listen";
    this.talk(false);
    this.playAt = Date.now() + LEAD_MS * MimicRoom.pace;
    this.endsAt = this.playAt + (this.seconds() * 1000 + AFTER_SOUND_MS) * MimicRoom.pace;
    this.later(LEAD_MS + this.seconds() * 1000 + AFTER_SOUND_MS, () => this.record());
  }

  /** Everyone imitates, as many takes as they like, until the timer (or until everyone is done). */
  private record() {
    const ms = RECORD_MS + this.seconds() * 1000;
    this.phase = "record";
    this.endsAt = Date.now() + ms * MimicRoom.pace;
    this.later(ms, () => this.judge());
  }

  private handleDone(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "record" || !seat || seat.takes === 0) return;
    seat.done = true;
    this.checkAllDone();
  }

  private checkAllDone() {
    const present = this.seats.filter((s) => !s.left && s.connected);
    if (this.phase === "record" && present.every((s) => s.done)) this.judge();
    if (this.phase === "after" && present.every((s) => s.ready)) this.nextOrEnd();
  }

  /** The results: every take played to everyone, then its score — the lowest first, the round's best last. */
  private judge() {
    this.order = this.seats
      .filter((s) => this.clips.has(s.id))
      .sort((a, b) => a.score - b.score || Math.random() - 0.5)
      .map((s) => s.id);
    this.phase = "judge";
    this.judged = -1;
    this.nextTake();
  }

  private nextTake() {
    this.judged++;
    const seat = this.seat(this.order[this.judged] ?? "");
    if (!seat) return this.after();
    this.takeAt = Date.now() + TAKE_LEAD_MS * MimicRoom.pace;
    this.scoreAt = this.takeAt + seat.ms * MimicRoom.pace;
    this.endsAt = this.scoreAt + SCORE_MS * MimicRoom.pace;
    this.later(TAKE_LEAD_MS + seat.ms + SCORE_MS, () => this.nextTake());
  }

  /** All heard: a moment to hear them again; "next" when ready. */
  private after() {
    for (const s of this.seats) s.scores[this.round - 1] = Math.max(0, s.score);
    this.phase = "after";
    this.talk(true);
    this.endsAt = Date.now() + AFTER_MS * MimicRoom.pace;
    this.later(AFTER_MS, () => this.nextOrEnd());
  }

  private handleNext(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "after" || !seat) return;
    seat.ready = true;
    this.checkAllDone();
  }

  private nextOrEnd() {
    if (this.round >= this.rounds) return this.finish();
    this.startRound();
  }

  private finish() {
    this.timer?.clear();
    this.phase = "result";
    this.talk(true);
    this.endsAt = 0;
    this.clips.clear();
  }

  /** The host takes everyone back to the waiting room; newcomers can join again. */
  private handlePlayAgain(client: Client) {
    if (this.phase !== "result" || client.sessionId !== this.hostId) return;
    this.seats = this.seats.filter((s) => !s.left);
    for (const s of this.seats) Object.assign(s, { scores: [], score: -1, ms: 0, takes: 0, done: false, ready: false });
    this.round = 0;
    this.sound = "";
    this.order = [];
    this.phase = "lobby";
    this.unlock();
    this.updateListing();
  }

  // ---- the takes (HTTP, see app.config) ----

  /** A player's take of this round (16 kHz mono WAV) and its score: the last one counts. False when refused. */
  addTake(session: string, token: string, round: number, score: number, wav: Buffer) {
    const seat = this.seat(session);
    if (!seat || seat.token !== token || round !== this.round || this.phase !== "record" || seat.done) return false;
    if (wav.length <= 44 || wav.length > MAX_CLIP_BYTES || !Number.isFinite(score)) return false;
    // ponytail: the phone's score is trusted (a party game); score the take here if cheating shows up
    this.clips.set(session, wav);
    seat.score = Math.round(Math.max(0, Math.min(100, score)));
    seat.ms = Math.round((wav.length - 44) / PCM_BYTES_PER_MS);
    seat.takes++;
    this.sync();
    return true;
  }

  /** A take, once the results have started. */
  clip(round: number, session: string) {
    if (round !== this.round || (this.phase !== "judge" && this.phase !== "after")) return undefined;
    return this.clips.get(session);
  }

  // ---- sync ----

  private later(ms: number, then: () => void) {
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms * MimicRoom.pace);
  }

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private updateListing() {
    this.setMatchmaking({
      metadata: {
        host: this.seat(this.hostId)?.name ?? "",
        hostAvatar: this.seat(this.hostId)?.avatar ?? 0,
        hostFrame: this.seat(this.hostId)?.frame ?? 0,
        roomType: this.roomType,
        started: this.phase !== "lobby",
        players: this.seats.length,
        maxPlayers: MAX_SEATS,
        spectators: 0,
      },
    });
  }

  private sync() {
    // A score shows once its take is being played (the phones hold it back until the take has been heard).
    const shown = (s: Seat) =>
      this.phase === "after" || this.phase === "result" ||
      (this.phase === "judge" && this.order.indexOf(s.id) >= 0 && this.order.indexOf(s.id) <= this.judged);
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      rounds: this.rounds,
      category: this.category,
      round: this.round,
      sound: this.sound,
      playAt: this.playAt,
      endsAt: this.endsAt,
      order: this.order,
      judged: this.judged,
      takeAt: this.takeAt,
      scoreAt: this.scoreAt,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, connected: s.connected, bot: "",
        left: s.left, takes: s.takes, done: s.done, ready: s.ready, ms: s.ms,
        score: shown(s) ? s.score : -1, scores: s.scores,
      })),
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      client.send("mimic", { ...table, me: client.sessionId, token: this.seat(client.sessionId)?.token ?? "" });
    }
  }
}
