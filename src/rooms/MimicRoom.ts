import { Room, Client, ServerError } from "colyseus";
import { randomBytes } from "node:crypto";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, firebaseEnabled, isFriendOfAny, setRoom, type Account } from "../firebase.js";
import { MIMIC_SOUNDS } from "../mimicSounds.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";

/**
 * Mimic Party: each round everyone hears a well-known sound (a cow, a siren, a sneeze…) and imitates it; each
 * phone scores its own imitation out of 100 (the shape of the sound: its rhythm, its melody, its brightness)
 * and sends the score, and the recording over HTTP (/api/mimic/clip). The best of a player's attempts counts.
 * All together: everyone records at once, then the round's scores, the best and the worst imitations played;
 * one at a time: each plays in turn while the others watch his waveform, then everyone hears him.
 * The next round when everyone taps "next", or after a minute; the winner has the best average.
 *
 * No schema: everyone gets the "mimic" message after every change; "mimic_level" carries the live waveform of
 * whoever is imitating (one at a time).
 */
type Mode = "together" | "turns";
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; roomType: string; started: boolean;
  players: number; maxPlayers: number; spectators: number;
};
type Settings = { roomType?: string; rounds?: number; category?: string; mode?: string; attempts?: number };
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
  token: string; // for his recordings' uploads
  scores: number[]; // each round's
  best: number; // this round's best attempt (-1 none yet)
  tries: number;
  done: boolean; // no more attempts this round
  ready: boolean; // tapped "next round"
  clip: number; // his recording's version this round (0: none)
};
type Phase = "lobby" | "listen" | "record" | "perform" | "replay" | "reveal" | "result";

const ROOM_TYPES = ["public", "friends", "private"];
const ROUNDS = [5, 10, 15];
const CATEGORIES = [...new Set(MIMIC_SOUNDS.map((s) => s.cat))];
const MAX_SEATS = 12;
const LEAD_MS = 800; // the sound starts this long after the phase, everywhere at once
const AFTER_SOUND_MS = 1_500;
const ATTEMPT_MS = 7_000; // per attempt, besides the sound's length: the countdown, the score
const REVEAL_MS = 60_000; // then the next round anyway
const REPLAY_MS = 3_500; // besides the recording's length
const MAX_CLIP_BYTES = 400_000;
const RECONNECT_SECONDS = 600;

export class MimicRoom extends Room<{ metadata: Meta }> {
  static pace = 1; // tests: every timer shorter
  maxClients = MAX_SEATS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private rounds = 10;
  private category = "random";
  private mode: Mode = "together";
  private attempts = 1;
  private seats: Seat[] = [];
  private members = new Map<string, string>();
  private invited = new Set<string>();
  private round = 0;
  private deck: string[] = []; // the sounds still to come
  private sound = "";
  private playAt = 0; // when the sound plays, server time
  private endsAt = 0;
  private order: string[] = []; // one at a time: who imitates, in turn
  private performer = "";
  private clips = new Map<string, Buffer>(); // "<round>/<seat>" → WAV
  private timer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("mimic_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on("start_game", (c) => this.handleStart(c));
    on<{ score?: number }>("score", (c, m) => this.handleScore(c.sessionId, Number(m.score)));
    on("keep", (c) => this.handleKeep(c.sessionId));
    on("next", (c) => this.handleNext(c.sessionId));
    on("play_again", (c) => this.handlePlayAgain(c));
    this.onMessage("level", (client, msg: { v?: unknown }) => {
      // One at a time: the live waveform of whoever imitates, to the others.
      if (this.phase !== "perform" || client.sessionId !== this.performer || !Array.isArray(msg?.v)) return;
      const v = msg.v.slice(0, 50).map((x) => Math.max(0, Math.min(1, Number(x) || 0)));
      this.broadcast("mimic_level", { v }, { except: client });
    });
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
      best: -1,
      tries: 0,
      done: false,
      ready: false,
      clip: 0,
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
      if (this.performer === id && this.phase === "perform") this.finishPerformer();
      else this.checkAllDone();
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

  /** Mics off while the sound plays and while players imitate (the recordings stay clean, the mic free). */
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
    if (s.mode === "together" || s.mode === "turns") this.mode = s.mode;
    const a = Number(s.attempts);
    if (a === 1 || a === 2 || a === 3) this.attempts = a;
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

  private playing() {
    return this.seats.filter((s) => !s.left);
  }

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
    for (const s of this.seats) Object.assign(s, { best: -1, tries: 0, done: s.left, ready: s.left, clip: 0 });
    this.clips.clear(); // only this round's recordings are kept
    this.phase = "listen";
    this.talk(false);
    this.playAt = Date.now() + LEAD_MS;
    this.endsAt = this.playAt + this.seconds() * 1000 + AFTER_SOUND_MS;
    this.later(LEAD_MS + this.seconds() * 1000 + AFTER_SOUND_MS, () => {
      if (this.mode === "together") return this.record();
      this.order = this.playing().map((s) => s.id);
      this.nextPerformer(0);
    });
  }

  private attemptsMs() {
    return this.attempts * (this.seconds() * 1000 + ATTEMPT_MS) + 10_000;
  }

  /** All together: everyone imitates, as many times as allowed. */
  private record() {
    this.phase = "record";
    this.endsAt = Date.now() + this.attemptsMs() * MimicRoom.pace;
    this.later(this.attemptsMs(), () => this.reveal());
  }

  /** One at a time: [k]'s turn (who left is skipped). */
  private nextPerformer(k: number) {
    const id = this.order.slice(k).find((x) => !this.seat(x)?.left);
    if (!id) return this.reveal();
    this.performer = id;
    this.phase = "perform";
    this.talk(false);
    this.endsAt = Date.now() + this.attemptsMs() * MimicRoom.pace;
    this.later(this.attemptsMs(), () => this.finishPerformer());
  }

  /** His turn is over: everyone hears him (if he imitated at all), then the next one. */
  private finishPerformer() {
    const seat = this.seat(this.performer);
    const k = this.order.indexOf(this.performer);
    if (seat) seat.done = true;
    if (!seat || seat.tries === 0) return this.nextPerformer(k + 1);
    this.phase = "replay";
    this.talk(true);
    this.endsAt = Date.now() + (this.seconds() * 1000 + REPLAY_MS) * MimicRoom.pace;
    this.later(this.seconds() * 1000 + REPLAY_MS, () => this.nextPerformer(k + 1));
  }

  /** An attempt's score (his phone's ear): the best one counts. */
  private handleScore(id: string, score: number) {
    const seat = this.seat(id);
    const mine = this.phase === "record" || (this.phase === "perform" && id === this.performer);
    if (!seat || !mine || seat.done || !Number.isFinite(score)) return;
    // ponytail: the phone's score is trusted (a party game); score the uploaded clip here if cheating shows up
    seat.best = Math.max(seat.best, Math.round(Math.max(0, Math.min(100, score))));
    seat.tries++;
    if (seat.tries >= this.attempts) this.handleKeep(id);
  }

  /** Happy with it (or out of attempts). */
  private handleKeep(id: string) {
    const seat = this.seat(id);
    const mine = this.phase === "record" || (this.phase === "perform" && id === this.performer);
    if (!seat || !mine || seat.tries === 0) return;
    seat.done = true;
    if (this.phase === "perform") this.finishPerformer();
    else this.checkAllDone();
  }

  private checkAllDone() {
    if (this.phase === "record" && this.seats.every((s) => s.done || !s.connected)) this.reveal();
    if (this.phase === "reveal" && this.seats.every((s) => s.ready || !s.connected)) this.nextOrEnd();
  }

  /** The round's scores (the best and the worst imitations play), "next" when ready. */
  private reveal() {
    for (const s of this.seats) s.scores[this.round - 1] = Math.max(0, s.best);
    this.phase = "reveal";
    this.talk(true);
    this.performer = "";
    this.endsAt = Date.now() + REVEAL_MS * MimicRoom.pace;
    this.later(REVEAL_MS, () => this.nextOrEnd());
  }

  private handleNext(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "reveal" || !seat) return;
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
    for (const s of this.seats) Object.assign(s, { scores: [], best: -1, tries: 0, done: false, ready: false, clip: 0 });
    this.round = 0;
    this.sound = "";
    this.phase = "lobby";
    this.unlock();
    this.updateListing();
  }

  // ---- recordings (HTTP, see app.config) ----

  /** A player's recording of this round (his best attempt so far). False when it isn't his to send. */
  addClip(session: string, token: string, round: number, wav: Buffer) {
    const seat = this.seat(session);
    if (!seat || seat.token !== token || round !== this.round || wav.length > MAX_CLIP_BYTES) return false;
    if (!["record", "perform", "replay", "reveal"].includes(this.phase)) return false;
    this.clips.set(`${round}/${session}`, wav);
    seat.clip++;
    this.sync();
    return true;
  }

  clip(round: number, session: string) {
    return this.clips.get(`${round}/${session}`);
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
    // The round's scores show at its end (one at a time: each one's after his turn).
    const shown = (s: Seat) =>
      this.phase === "reveal" || this.phase === "result" || (this.mode === "turns" && s.done && s.id !== this.performer) ||
      (this.phase === "replay" && s.id === this.performer);
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      rounds: this.rounds,
      category: this.category,
      mode: this.mode,
      attempts: this.attempts,
      round: this.round,
      sound: this.sound,
      playAt: this.playAt,
      endsAt: this.endsAt,
      performer: this.performer,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, connected: s.connected, bot: "",
        left: s.left, tries: s.tries, done: s.done, ready: s.ready, clip: s.clip,
        best: shown(s) ? s.best : -1, scores: s.scores,
      })),
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = this.seat(client.sessionId);
      client.send("mimic", { ...table, me: client.sessionId, token: me?.token ?? "", myBest: me?.best ?? -1 });
    }
  }
}
