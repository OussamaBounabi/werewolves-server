import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, firebaseEnabled, isFriendOfAny, setRoom, type Account } from "../firebase.js";
import { CATEGORIES, WORDS, wordsOf, type Word } from "../imposterWords.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";

/**
 * Imposter: everyone gets the same secret word, except one or two imposters who only know its category. They
 * talk (the mic) until the timer ends or most of them want to vote, then everyone votes (or skips). The most
 * voted player is revealed: an imposter gets one guess at the word — right, and the imposters win anyway.
 * One vote decides the game, or (a room setting) the voted player is out and the rounds go on until the
 * imposters are all out, or as many as the others. A tie, or skips as many as the top vote: nobody is out.
 * Winners score 1 point, imposters 2; the scores stay for the room's next games.
 *
 * No schema: everyone gets the "imposter" message after every change (with his own card only).
 */
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; roomType: string; started: boolean;
  players: number; maxPlayers: number; spectators: number;
};
type Settings = { roomType?: string; imposters?: number; category?: string; talk?: number; mode?: string };
type JoinOptions = Settings & { name?: string; playerId?: string; idToken?: string };
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number;
  connected: boolean;
  imposter: boolean;
  out: boolean; // voted out, or left the game
  left: boolean;
  seen: boolean; // has looked at his card
  wantsVote: boolean; // pressed "vote" during the talk
  vote: string | null; // during the vote: who ("" skips), null not yet
  score: number;
  gained: number; // the last game's points
};
type Phase = "lobby" | "reveal" | "talk" | "vote" | "verdict" | "guess" | "result";

const ROOM_TYPES = ["public", "friends", "private"];
const TALK_OPTIONS = [60, 120, 180, 240, 300];
const MAX_SEATS = 12;
const MIN_PLAYERS = 3;
const REVEAL_MS = 20_000; // looking at one's card
const VOTE_MS = 30_000;
const VERDICT_MS = 4_000; // who was voted out, and what he was
const GUESS_MS = 25_000;
const RECONNECT_SECONDS = 600;

export class ImposterRoom extends Room<{ metadata: Meta }> {
  static pace = 1; // tests: every timer shorter
  maxClients = MAX_SEATS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private imposters = 1;
  private category = "random"; // or one of CATEGORIES
  private talkSeconds = 180;
  private mode: "single" | "elimination" = "single";
  private seats: Seat[] = [];
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private word: Word | null = null;
  private round = 0;
  private endsAt = 0;
  private votedOut = ""; // the vote's result ("" nobody)
  private guessed = ""; // the caught imposter's guess (a word id)
  private winner: "" | "players" | "imposters" = "";
  private timer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("imposter_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on("start_game", (c) => this.handleStart(c));
    on("seen", (c) => this.handleSeen(c.sessionId));
    on("vote_now", (c) => this.handleVoteNow(c.sessionId));
    on<{ target?: string }>("vote", (c, m) => this.handleVote(c.sessionId, String(m.target ?? "")));
    on<{ word?: string }>("guess", (c, m) => this.handleGuess(c.sessionId, String(m.word ?? "")));
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
      avatar: account?.avatar ?? randomAvatar(), // no account (a test client): a character at random
      frame: account?.frame ?? randomFrame(),
      connected: true,
      imposter: false,
      out: false,
      left: false,
      seen: false,
      wantsVote: false,
      vote: null,
      score: ghost?.score ?? 0,
      gained: 0,
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
    if (this.phase === "lobby" || this.phase === "result") this.removeSeat(id);
    else this.leaveGame(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.left && this.clients.getById(s.id))?.id ?? "";
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.timer?.clear();
    if (voiceEnabled) closeVoice(this.roomId).catch(() => {});
  }

  private async handleVoiceJoin(client: Client) {
    if (!voiceEnabled) return client.send("voice", { enabled: false });
    const seat = this.seat(client.sessionId);
    const talk = !seat?.out;
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, seat?.name ?? "player", { talk, hear: true })) });
  }

  /** Who's out of the game hears but doesn't talk; back in the waiting room, everyone talks again. */
  private voice(seat: Seat, talk: boolean) {
    if (voiceEnabled && !seat.left) setVoiceRights(this.roomId, seat.id, { talk, hear: true }).catch(() => {});
  }

  // ---- the waiting room ----

  private applySettings(s: Settings) {
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    const n = Number(s.imposters);
    if (n === 1 || n === 2) this.imposters = n;
    if (s.category === "random" || CATEGORIES.includes(s.category as string)) this.category = s.category as string;
    if (TALK_OPTIONS.includes(Number(s.talk))) this.talkSeconds = Number(s.talk);
    if (s.mode === "single" || s.mode === "elimination") this.mode = s.mode;
    this.updateListing();
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId) return;
    if (this.seats.length < MIN_PLAYERS) return "not_enough_players";
    if (this.seats.length < 2 * this.imposters + 1) return "too_few_for_two"; // two imposters: five players at least
    this.lock();
    const pool = this.category === "random" ? WORDS : wordsOf(this.category);
    this.word = pool[Math.floor(Math.random() * pool.length)];
    const order = this.seats.map((_, i) => i).sort(() => Math.random() - 0.5);
    this.seats.forEach((s, i) =>
      Object.assign(s, { imposter: order.indexOf(i) < this.imposters, out: false, seen: false, wantsVote: false, vote: null, gained: 0 }),
    );
    this.round = 1;
    this.votedOut = "";
    this.guessed = "";
    this.winner = "";
    this.phase = "reveal";
    this.endsAt = Date.now() + REVEAL_MS * ImposterRoom.pace;
    this.later(REVEAL_MS, () => this.talk());
  }

  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.seats.splice(index, 1);
    if (this.hostId === id) this.hostId = this.seats[0]?.id ?? "";
  }

  // ---- the game ----

  private alive() {
    return this.seats.filter((s) => !s.out);
  }

  private handleSeen(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "reveal" || !seat) return;
    seat.seen = true;
    if (this.alive().every((s) => s.seen || !s.connected)) this.talk();
  }

  private talk() {
    this.phase = "talk";
    this.votedOut = "";
    for (const s of this.seats) s.wantsVote = false;
    this.endsAt = Date.now() + this.talkSeconds * 1000;
    this.later(this.talkSeconds * 1000, () => this.vote(), 1);
  }

  /** "Let's vote": once more than half of the players still in want to, the vote starts. */
  private handleVoteNow(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "talk" || !seat || seat.out) return;
    seat.wantsVote = !seat.wantsVote;
    const alive = this.alive();
    if (alive.filter((s) => s.wantsVote).length * 2 > alive.length) this.vote();
  }

  private vote() {
    this.phase = "vote";
    for (const s of this.seats) s.vote = null;
    this.endsAt = Date.now() + VOTE_MS * ImposterRoom.pace;
    this.later(VOTE_MS, () => this.tally());
  }

  private handleVote(id: string, target: string) {
    const seat = this.seat(id);
    if (this.phase !== "vote" || !seat || seat.out) return;
    if (target && (target === id || !this.alive().some((s) => s.id === target))) return;
    seat.vote = target; // "" skips; a new vote replaces the last one until everyone has voted
    if (this.alive().every((s) => s.vote !== null || !s.connected)) this.tally();
  }

  /** The most voted is out — unless it's a tie, or as many skipped (not voting is skipping). */
  private tally() {
    const counts = new Map<string, number>();
    let skips = 0;
    for (const s of this.alive()) {
      if (s.vote) counts.set(s.vote, (counts.get(s.vote) ?? 0) + 1);
      else skips++;
    }
    let top = "", best = 0, tie = false;
    for (const [target, n] of counts) {
      if (n > best) [top, best, tie] = [target, n, false];
      else if (n === best) tie = true;
    }
    this.votedOut = !tie && best > skips ? top : "";
    this.phase = "verdict";
    this.endsAt = 0;
    this.later(VERDICT_MS, () => this.afterVerdict());
  }

  private afterVerdict() {
    const out = this.seat(this.votedOut);
    if (!out) return this.mode === "single" ? this.finish("imposters") : this.nextRound();
    if (out.imposter) {
      // Caught: one guess at the word.
      this.phase = "guess";
      this.guessed = "";
      this.endsAt = Date.now() + GUESS_MS * ImposterRoom.pace;
      return this.later(GUESS_MS, () => this.afterGuess(false));
    }
    if (this.mode === "single") return this.finish("imposters");
    this.knockOut(out);
    if (!this.decided()) this.nextRound();
  }

  private handleGuess(id: string, word: string) {
    if (this.phase !== "guess" || id !== this.votedOut || !this.word) return;
    if (!wordsOf(this.word.cat).some((w) => w.id === word)) return "unknown_word";
    this.guessed = word;
    this.afterGuess(word === this.word.id);
  }

  private afterGuess(right: boolean) {
    if (right) return this.finish("imposters");
    if (this.mode === "single") return this.finish("players");
    this.knockOut(this.seat(this.votedOut)!);
    if (!this.decided()) this.nextRound();
  }

  private knockOut(seat: Seat) {
    seat.out = true;
    this.voice(seat, false);
  }

  /** All the imposters out: the players win; as many imposters as the others: the imposters win. */
  private decided() {
    const alive = this.alive();
    const imposters = alive.filter((s) => s.imposter).length;
    if (imposters === 0) this.finish("players");
    else if (imposters >= alive.length - imposters) this.finish("imposters");
    else return false;
    return true;
  }

  private nextRound() {
    this.round++;
    this.talk();
  }

  /** Someone leaves mid-game: he's out (an imposter caught on his way out guesses nothing). */
  private leaveGame(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.left) return;
    seat.left = true;
    seat.connected = false;
    if (seat.out) return;
    seat.out = true;
    if (this.phase === "guess" && id === this.votedOut) return this.afterGuess(false);
    if (this.decided()) return;
    if (this.phase === "reveal" && this.alive().every((s) => s.seen || !s.connected)) this.talk();
    else if (this.phase === "vote" && this.alive().every((s) => s.vote !== null || !s.connected)) this.tally();
  }

  private finish(winner: "players" | "imposters") {
    this.timer?.clear();
    this.winner = winner;
    this.phase = "result";
    this.endsAt = 0;
    for (const s of this.seats) {
      s.gained = winner === "imposters" ? (s.imposter ? 2 : 0) : s.imposter ? 0 : 1;
      s.score += s.gained;
      this.voice(s, true);
    }
  }

  /** The host takes everyone back to the waiting room (the scores stay); newcomers can join again. */
  private handlePlayAgain(client: Client) {
    if (this.phase !== "result" || client.sessionId !== this.hostId) return;
    this.seats = this.seats.filter((s) => !s.left);
    for (const s of this.seats) Object.assign(s, { imposter: false, out: false, seen: false, wantsVote: false, vote: null });
    this.word = null;
    this.phase = "lobby";
    this.unlock();
    this.updateListing();
  }

  // ---- sync ----

  /** [then] in [ms] (shortened by the tests' pace; the talk passes [scale] 1), then everyone is told. */
  private later(ms: number, then: () => void, scale = ImposterRoom.pace) {
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms * scale);
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
    const over = this.phase === "result";
    const counts: Record<string, number> = {};
    let skips = 0;
    if (this.phase === "vote" || this.phase === "verdict") {
      for (const s of this.alive()) {
        if (s.vote) counts[s.vote] = (counts[s.vote] ?? 0) + 1;
        else if (s.vote === "") skips++;
      }
    }
    // Roles are secret until the end, but whoever is voted out is shown for what he is.
    const known = (s: Seat) => over || (s.out && !s.left) || (s.id === this.votedOut && ["verdict", "guess"].includes(this.phase));
    const word = this.word && { id: this.word.id, en: this.word.en, fr: this.word.fr, ar: this.word.ar };
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      imposters: this.imposters,
      category: this.category,
      talk: this.talkSeconds,
      mode: this.mode,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, connected: s.connected, bot: "",
        out: s.out, left: s.left, seen: s.seen, wantsVote: s.wantsVote, voted: s.vote !== null,
        role: known(s) ? (s.imposter ? "imposter" : "player") : "", score: s.score, gained: s.gained,
      })),
      wordCategory: this.word?.cat ?? "",
      round: this.round,
      endsAt: this.endsAt,
      counts,
      skips,
      votedOut: this.votedOut,
      guessed: over ? this.guessed : "",
      word: over ? word : null,
      winner: this.winner,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = this.seat(client.sessionId);
      const playing = this.phase !== "lobby" && me && this.word;
      client.send("imposter", {
        ...table,
        me: client.sessionId,
        card: playing ? (me.imposter ? { imposter: true } : { imposter: false, word }) : null,
        myVote: me?.vote ?? null,
        // The caught imposter's last chance: the category's words.
        options: this.phase === "guess" && me?.id === this.votedOut && this.word ? wordsOf(this.word.cat) : [],
      });
    }
  }
}
