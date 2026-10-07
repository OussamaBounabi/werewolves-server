import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, firebaseEnabled, isFriendOfAny, setRoom, type Account } from "../firebase.js";
import {
  botMove, bracket, covers, found, nextSlot, player, randomPlayer, validQuestion, valueOf,
  type Answer, type Match, type Question,
} from "../guess.js";
import { closeVoice, dropFromVoice, voiceEnabled, voiceToken } from "../voice.js";

/**
 * Guess Who, football edition. Each player has a secret footballer; turn by turn they ask about the other's
 * (position, nationality, club, shirt number — a question may cover several at once: "is he from Europe?")
 * or guess who he is. A wrong guess only costs the turn. Each player has his own clock for the round,
 * running on his turn only: out of time, he loses the round. Best of 1, 3 or 5.
 * Trust mode: no questions on screen — they ask out loud, and whoever's footballer is found says so (the
 * other wins the round); one clock for both, and when it runs out the round is played again.
 * 1 vs 1, or a cup of 4 or 8: one match at a time, the others waiting (and, a room setting, seeing both
 * secrets). Who leaves loses his match; his next opponent goes through.
 *
 * No schema: everyone gets the "guess" message after every change (the secrets only to who may see them),
 * and "guess_fx" (answers, guesses, round ends) to animate.
 */
type Mode = "duel" | "cup";
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; roomType: string; started: boolean;
  players: number; maxPlayers: number; spectators: number; mode: Mode;
};
type Settings = { roomType?: string; rounds?: number; random?: boolean; trust?: boolean; time?: number; cupSize?: number; spectate?: boolean };
type JoinOptions = Settings & { mode?: string; name?: string; playerId?: string; idToken?: string };
type Seat = { id: string; playerId: string; name: string; uid: string; avatar: number; frame: number; connected: boolean; bot: boolean; quit: boolean };
/** One of the match's two players: a (blue) or b (red). */
type Side = {
  id: string;
  secret: string; // his footballer
  answers: Answer[]; // his questions about the other's, answered
  wrong: string[]; // the footballers he guessed wrong
  clockMs: number; // what's left of his time this round
};
type Phase = "lobby" | "bracket" | "pick" | "playing" | "round" | "between" | "gameover";

const ROOM_TYPES = ["public", "friends", "private"];
const ROUNDS = [1, 3, 5];
const CUP_SIZES = [4, 8];
const TIME_MIN = 30, TIME_MAX = 900, TIME_STEP = 30; // seconds per player and round
const PICK_MS = 30_000; // picking one's footballer (random off)
const ANSWER_MS = 1_600; // the answer shows, then the turn passes
const ROUND_END_MS = 5_000; // both footballers revealed
const BRACKET_MS = 6_000; // the cup's draw, and the bracket between matches
const RECONNECT_SECONDS = 600;
const CLOSE_AFTER_GAME_MS = 90_000;
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];

export class GuessRoom extends Room<{ metadata: Meta }> {
  static botSpeed = 1; // tests: bots think faster
  static pace = 1; // tests: every pause shorter

  private mode: Mode = "duel";
  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private rounds = 3;
  private random = true; // the footballers are drawn; off: each player picks his own
  private trust = false;
  private time = 180;
  private cupSize = 8;
  private spectate = false; // a cup's waiting players see both secrets
  private seats: Seat[] = [];
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private botSeq = 0;
  private matches: Match[] = []; // a cup's, in playing order (1 vs 1: one)
  private current = -1; // the match being played
  private sides: Side[] = [];
  private firstTurn = 0; // who starts the match's first round (they take turns starting)
  private roundNo = 0;
  private turn = ""; // whose turn ("" while an answer shows, between rounds…)
  private turnStartedAt = 0;
  private endsAt = 0; // picking ends / trust mode's clock
  private roundWinner = -1; // the round just played: 0 a, 1 b, -1 nobody
  private champion = "";
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.mode = options.mode === "cup" ? "cup" : "duel";
    this.maxClients = this.mode === "cup" ? Math.max(...CUP_SIZES) : 2;
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("guess_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on("add_bot", (c) => this.handleAddBot(c));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on<{ player: string }>("pick", (c, m) => this.handlePick(c.sessionId, String(m.player)));
    on<Question>("ask", (c, m) => this.handleAsk(c.sessionId, m));
    on<{ player: string }>("guess", (c, m) => this.handleGuess(c.sessionId, String(m.player)));
    on("concede", (c) => this.handleConcede(c.sessionId));
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
    if (this.seats.length >= this.capacity()) throw new ServerError(4409, "full");
    if (this.roomType !== "public" && !this.seats.every((s) => s.bot)) {
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
      bot: false,
      quit: false,
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
    if (this.phase === "lobby") this.removeSeat(id);
    else if (this.phase !== "gameover") this.quit(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && !s.quit && this.clients.getById(s.id))?.id ?? "";
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.timer?.clear();
    this.botTimer?.clear();
    if (voiceEnabled) closeVoice(this.roomId).catch(() => {});
  }

  private async handleVoiceJoin(client: Client) {
    if (!voiceEnabled) return client.send("voice", { enabled: false });
    const name = this.seat(client.sessionId)?.name ?? "player";
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, name, { talk: true, hear: true })) });
  }

  // ---- the waiting room ----

  private capacity() {
    return this.mode === "cup" ? this.cupSize : 2;
  }

  private applySettings(s: Settings) {
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (ROUNDS.includes(Number(s.rounds))) this.rounds = Number(s.rounds);
    if (typeof s.random === "boolean") this.random = s.random;
    if (typeof s.trust === "boolean") {
      this.trust = s.trust;
      if (this.trust) this.seats = this.seats.filter((x) => !x.bot); // bots can't talk
    }
    const t = Number(s.time);
    if (Number.isInteger(t) && t >= TIME_MIN && t <= TIME_MAX && t % TIME_STEP === 0) this.time = t;
    const size = Number(s.cupSize);
    if (this.mode === "cup" && CUP_SIZES.includes(size) && size >= this.seats.length) this.cupSize = size;
    if (typeof s.spectate === "boolean") this.spectate = s.spectate;
    this.updateListing();
  }

  private handleAddBot(client: Client) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId || this.trust) return;
    if (this.seats.length >= this.capacity()) return;
    const taken = new Set(this.seats.map((s) => s.name));
    const id = `bot-${++this.botSeq}`;
    this.seats.push({
      id,
      playerId: id,
      name: BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${this.botSeq}`,
      uid: "",
      avatar: 0,
      frame: 0,
      connected: true,
      bot: true,
      quit: false,
    });
    this.updateListing();
  }

  private handleRemoveBot(client: Client, id: string) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId || !this.seat(id)?.bot) return;
    this.removeSeat(id);
    this.updateListing();
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId) return;
    if (this.seats.length < this.capacity()) return "not_enough_players";
    this.lock();
    if (this.mode === "duel") {
      this.matches = [{ a: this.seats[0].id, b: this.seats[1].id, winner: "", rounds: [] }];
      return this.startMatch(0);
    }
    this.matches = bracket(this.seats.map((s) => s.id));
    this.phase = "bracket";
    this.later(BRACKET_MS, () => this.startMatch(0));
  }

  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.seats.splice(index, 1);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot)?.id ?? "";
  }

  // ---- a match ----

  private startMatch(index: number) {
    this.current = index;
    const m = this.matches[index];
    // Someone who left loses without playing (both gone: the first one goes through — and loses his next).
    const gone = (id: string) => this.seat(id)?.quit !== false;
    if (gone(m.a) || gone(m.b)) {
      m.winner = gone(m.a) && !gone(m.b) ? m.b : m.a;
      return this.afterMatch();
    }
    this.sides = [m.a, m.b].map((id): Side => ({ id, secret: "", answers: [], wrong: [], clockMs: 0 }));
    this.firstTurn = Math.floor(Math.random() * 2);
    this.roundNo = 0;
    this.startRound();
  }

  private startRound() {
    this.roundNo++;
    this.roundWinner = -1;
    this.turn = "";
    for (const s of this.sides) Object.assign(s, { secret: "", answers: [], wrong: [], clockMs: this.time * 1000 });
    if (this.random) {
      this.sides[0].secret = randomPlayer().id;
      do this.sides[1].secret = randomPlayer().id;
      while (this.sides[1].secret === this.sides[0].secret);
      return this.play();
    }
    this.phase = "pick";
    this.endsAt = Date.now() + PICK_MS * GuessRoom.pace;
    for (const s of this.sides) if (this.seat(s.id)?.bot) s.secret = randomPlayer().id;
    this.later(PICK_MS, () => {
      for (const s of this.sides) s.secret ||= randomPlayer().id; // too slow: one at random
      this.play();
    });
  }

  private handlePick(id: string, footballer: string) {
    const side = this.sides.find((s) => s.id === id);
    if (this.phase !== "pick" || !side || side.secret) return;
    if (!player(footballer)) return "unknown_player";
    side.secret = footballer;
    if (this.sides.every((s) => s.secret)) this.play();
  }

  private play() {
    this.phase = "playing";
    if (this.trust) {
      this.endsAt = Date.now() + this.time * 1000;
      return this.later(this.time * 1000, () => this.roundOver(-1), 1);
    }
    this.startTurn(this.sides[(this.firstTurn + this.roundNo - 1) % 2].id);
  }

  private startTurn(id: string) {
    const side = this.side(id)!;
    this.turn = id;
    this.turnStartedAt = Date.now();
    this.later(side.clockMs, () => this.roundOver(1 - this.sides.indexOf(side)), 1); // out of time: the other wins
    if (this.seat(id)?.bot) this.botAct(id);
  }

  /** The turn's time comes off the player's clock. */
  private spend(side: Side) {
    side.clockMs = Math.max(0, side.clockMs - (Date.now() - this.turnStartedAt));
    this.turn = "";
  }

  private handleAsk(id: string, q: Question) {
    const side = this.side(id);
    if (this.phase !== "playing" || this.trust || this.turn !== id || !side) return;
    if (!validQuestion(q)) return "bad_question";
    if (found(side.answers, q.cat)) return "already_found";
    this.spend(side);
    const other = this.sides[1 - this.sides.indexOf(side)];
    const yes = covers(q).has(valueOf(player(other.secret)!, q.cat));
    side.answers.push({ cat: q.cat, items: [...new Set(q.items)], yes });
    this.broadcast("guess_fx", { type: "answer", who: id, cat: q.cat, items: q.items, yes });
    this.later(ANSWER_MS, () => this.startTurn(other.id));
  }

  private handleGuess(id: string, footballer: string) {
    const side = this.side(id);
    if (this.phase !== "playing" || this.trust || this.turn !== id || !side) return;
    if (!player(footballer) || side.wrong.includes(footballer)) return "unknown_player";
    this.spend(side);
    const i = this.sides.indexOf(side), other = this.sides[1 - i];
    const right = footballer === other.secret;
    this.broadcast("guess_fx", { type: "guess", who: id, player: footballer, right });
    if (right) return this.later(ANSWER_MS, () => this.roundOver(i));
    side.wrong.push(footballer); // only the turn is lost
    this.later(ANSWER_MS, () => this.startTurn(other.id));
  }

  /** Trust mode: "he found mine" — the other wins the round. */
  private handleConcede(id: string) {
    const i = this.sides.findIndex((s) => s.id === id);
    if (this.phase === "playing" && this.trust && i >= 0) this.roundOver(1 - i);
  }

  /** The round is over: [winner] takes it (-1: trust mode's time ran out, the round is played again). */
  private roundOver(winner: number) {
    const m = this.matches[this.current];
    this.turn = "";
    this.roundWinner = winner;
    if (winner >= 0) m.rounds.push(winner);
    this.phase = "round";
    this.broadcast("guess_fx", { type: "round", winner });
    const need = Math.ceil(this.rounds / 2);
    const won = [0, 1].findIndex((k) => m.rounds.filter((r) => r === k).length >= need);
    this.later(ROUND_END_MS, () => (won >= 0 ? this.endMatch(won) : this.startRound()));
  }

  private endMatch(winner: number) {
    this.matches[this.current].winner = this.sides[winner].id;
    this.turn = "";
    this.afterMatch();
  }

  /** The cup goes on with the next match (the bracket shows a moment), or the game is over. */
  private afterMatch() {
    const m = this.matches[this.current];
    const slot = this.mode === "cup" ? nextSlot(this.matches.length + 1, this.current) : null;
    if (!slot) {
      this.champion = m.winner;
      this.phase = "gameover";
      this.timer?.clear();
      this.botTimer?.clear();
      this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
      return;
    }
    this.matches[slot.match][slot.side] = m.winner;
    this.phase = "between";
    this.later(BRACKET_MS, () => this.startMatch(this.current + 1));
  }

  /** Who leaves a match in progress loses it; a cup's waiting player loses his match when it comes. */
  private quit(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.quit) return;
    seat.quit = true;
    seat.connected = false;
    const i = this.sides.findIndex((s) => s.id === id);
    if (i >= 0 && ["pick", "playing", "round"].includes(this.phase)) this.endMatch(1 - i);
  }

  // ---- bots ----

  private botAct(id: string) {
    this.botTimer?.clear();
    this.botTimer = this.clock.setTimeout(() => {
      const side = this.side(id);
      if (this.turn !== id || this.phase !== "playing" || !side) return;
      const move = botMove(side.answers, side.wrong);
      if ("guess" in move) this.handleGuess(id, move.guess);
      else this.handleAsk(id, move);
      this.sync();
    }, (1500 + Math.random() * 2500) * GuessRoom.botSpeed);
  }

  // ---- sync ----

  /** [then] in [ms] (shortened by the tests' pace; the players' clocks pass [scale] 1), then everyone is told. */
  private later(ms: number, then: () => void, scale = GuessRoom.pace) {
    this.timer?.clear();
    this.botTimer?.clear();
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms * scale);
  }

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private side(id: string) {
    return this.sides.find((s) => s.id === id);
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
        maxPlayers: this.capacity(),
        spectators: 0,
        mode: this.mode,
      },
    });
  }

  /** May [viewer] see [side]'s footballer? His own; everyone's once the round is over; a cup's waiting
   * players when the room allows it. */
  private sees(viewer: string, side: Side) {
    if (viewer === side.id || ["round", "between", "gameover"].includes(this.phase)) return true;
    return this.spectate && this.mode === "cup" && !this.sides.some((s) => s.id === viewer);
  }

  private sync() {
    const turnSide = this.side(this.turn);
    const table = {
      mode: this.mode,
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      rounds: this.rounds,
      random: this.random,
      trust: this.trust,
      time: this.time,
      cupSize: this.cupSize,
      spectate: this.spectate,
      maxPlayers: this.capacity(),
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, connected: s.connected, quit: s.quit,
        bot: s.bot ? "normal" : "", // as at the other tables
      })),
      matches: this.matches,
      current: this.current,
      round: this.roundNo,
      turn: this.turn,
      turnEndsAt: turnSide ? this.turnStartedAt + turnSide.clockMs : 0,
      endsAt: this.endsAt,
      roundWinner: this.roundWinner,
      champion: this.champion,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = client.sessionId;
      const sides = this.sides.map((s) => ({
        id: s.id, answers: s.answers, wrong: s.wrong, clockMs: s.clockMs, secret: this.sees(me, s) ? s.secret : "",
      }));
      client.send("guess", { ...table, sides, me });
    }
  }
}
