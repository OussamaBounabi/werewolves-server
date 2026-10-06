import { Room, Client, ServerError } from "colyseus";
import { accountFor, firebaseEnabled, isFriendOfAny, setRoom, type Account } from "../firebase.js";
import { botMove, HOME, movable, target, throwDie, victims, type Board, type BotLevel } from "../ludo.js";
import { closeVoice, dropFromVoice, voiceEnabled, voiceToken } from "../voice.js";

/**
 * Ludo, 2–4 players (bots included), 4 pawns each (or 2: quick game). A 6 takes a pawn out of the base
 * and rolls again — three 6s in a row lose the turn. Catching a pawn and getting one home roll again too.
 * Home takes the exact number; no blocks. Catching: automatic, or the player chooses (catch or share the
 * square) — a room setting. Start squares and stars are safe. Play goes on for 2nd and 3rd place.
 * 2 vs 2: partners on opposite corners, they never catch each other; who has all his pawns home plays
 * his partner's; the first pair home wins.
 *
 * No schema: everyone gets the "ludo" message after every change, and "ludo_fx" (rolls, moves) to animate.
 */
type Meta = { host: string; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type Settings = { roomType?: string; maxPlayers?: number; turnSeconds?: number; capture?: string; pawns?: number; teams?: boolean };
type JoinOptions = Settings & { name?: string; playerId?: string; idToken?: string };
type Aim = { dx?: number; dy?: number; power?: number }; // a swipe on the board: direction (board cells) and strength
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  connected: boolean;
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a normal bot
  auto: boolean; // "auto play": the bot plays for him
  color: number;
  pawns: number[];
};
type Phase = "lobby" | "playing" | "gameover";

const MAX_SEATS = 4;
const ROOM_TYPES = ["public", "friends", "private"];
const TURN_OPTIONS = [10, 15, 20, 30];
const CAPTURE_OPTIONS = ["auto", "ask"];
const PAWN_OPTIONS = [2, 4];
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
const LANDED_MS = 250; // the die has stopped: its number shows a moment
const HOP_MS = 160; // a pawn's hop from square to square
const NO_MOVE_MS = 1_200; // nothing to move: the roll is shown, then the turn moves on
const START_MS = 1_500;
const RECONNECT_SECONDS = 600;
const CLOSE_AFTER_GAME_MS = 60_000;

/** The colors around the board (clockwise from red, top left): 2 players face each other. */
export const colorsFor = (n: number) => (n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n));

export class LudoRoom extends Room<{ metadata: Meta }> {
  static botSpeed = 1; // tests: bots think (and the dice roll) faster
  maxClients = MAX_SEATS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private maxPlayers = 4;
  private turnSeconds = 15;
  private capture = "auto"; // ask: the player chooses to catch or to share the square
  private pawnCount = 4;
  private teams = false; // 2 vs 2: seats 0 & 2 against 1 & 3 (red & yellow, green & blue)
  private seats: Seat[] = []; // seat order = turn order (clockwise)
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private turn = "";
  private step: "roll" | "move" | "wait" = "roll";
  private dice = 0;
  private sixes = 0;
  private die = { x: 7.5, y: 7.5, value: 6 }; // it stays where it lands; the next throw starts there
  private turnEndsAt = 0;
  private places: string[] = []; // who finished, in order
  private botSeq = 0;
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("ludo_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on<{ level: string }>("add_bot", (c, m) => this.handleAddBot(c, m.level));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on<{ id: string }>("partner", (c, m) => this.handlePartner(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on<Aim>("roll", (c, m) => this.handleRoll(c.sessionId, m));
    on<{ pawn: number; capture?: boolean }>("move", (c, m) => this.handleMove(c.sessionId, Number(m.pawn), m.capture !== false));
    on<{ on: boolean }>("auto", (c, m) => this.handleAuto(c.sessionId, m.on === true));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (this.seat(client.sessionId) && typeof msg?.uid === "string") this.invited.add(msg.uid);
    });
    this.updateListing();
  }

  // ---- joining (as at the domino table) ----

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
    if (this.seats.length >= this.maxPlayers) throw new ServerError(4409, "full");
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
      avatar: account?.avatar ?? 0,
      connected: true,
      bot: null,
      auto: false,
      color: 0,
      pawns: [],
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
    else if (this.phase !== "gameover") this.becomeBot(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && this.clients.getById(s.id))?.id ?? "";
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

  private applySettings(s: Settings) {
    const n = Math.floor(Number(s.maxPlayers));
    if (n >= 2 && n <= MAX_SEATS) this.maxPlayers = Math.max(n, this.seats.length);
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
    if (CAPTURE_OPTIONS.includes(s.capture as string)) this.capture = s.capture as string;
    if (PAWN_OPTIONS.includes(Number(s.pawns))) this.pawnCount = Number(s.pawns);
    if (typeof s.teams === "boolean") this.teams = s.teams;
    if (this.teams) this.maxPlayers = 4;
    this.updateListing();
  }

  private handleAddBot(client: Client, level: string) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId || this.seats.length >= this.maxPlayers) return;
    const taken = new Set(this.seats.map((s) => s.name));
    const id = `bot-${++this.botSeq}`;
    this.seats.push({
      id,
      playerId: id,
      name: BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${this.botSeq}`,
      uid: "",
      avatar: 0,
      connected: true,
      bot: BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : "normal",
      auto: false,
      color: 0,
      pawns: [],
    });
    this.updateListing();
  }

  private handleRemoveBot(client: Client, id: string) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId || !this.seat(id)?.bot) return;
    this.removeSeat(id);
    this.updateListing();
  }

  /** 2 vs 2: the host picks his partner; seats become host, opponent, partner, opponent. */
  private handlePartner(client: Client, partnerId: string) {
    const host = client.sessionId;
    if (this.phase !== "lobby" || host !== this.hostId || !this.teams || host === partnerId) return;
    const partner = this.seat(partnerId);
    if (!partner) return;
    const others = this.seats.filter((x) => x.id !== host && x.id !== partnerId);
    this.seats = [this.seat(host)!, others[0], partner, others[1]].filter((x) => x !== undefined);
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId) return;
    if (this.seats.length < 2) return "not_enough_players";
    if (this.teams && this.seats.length !== 4) return "teams_need_four";
    this.lock();
    const colors = colorsFor(this.seats.length);
    this.seats.forEach((s, i) => {
      s.color = colors[i];
      s.pawns = Array(this.pawnCount).fill(-1);
    });
    this.phase = "playing";
    this.startTurn(this.seats[Math.floor(Math.random() * this.seats.length)].id, START_MS); // a random first player
  }

  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.seats.splice(index, 1);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot)?.id ?? "";
  }

  private becomeBot(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.bot) return;
    seat.bot = "normal";
    seat.connected = true;
    if (this.turn === id && this.phase === "playing" && this.step !== "wait") this.botAct(id, 300);
  }

  private handleAuto(id: string, on: boolean) {
    const seat = this.seat(id);
    if (!seat || seat.bot || this.phase !== "playing") return;
    seat.auto = on;
    if (!on && this.turn === id) this.botTimer?.clear();
    if (on && this.turn === id && this.step !== "wait") this.botAct(id, 300);
  }

  // ---- the game ----

  private friends(a: number, b: number) {
    if (!this.teams) return false;
    const i = this.seats.findIndex((s) => s.color === a), j = this.seats.findIndex((s) => s.color === b);
    return i % 2 === j % 2;
  }

  private board(): Board {
    return new Map(this.seats.map((s) => [s.color, s.pawns]));
  }

  private done(seat: Seat) {
    return seat.pawns.every((p) => p === HOME);
  }

  /** Whose pawns [seat] moves: his own, or (2 vs 2, all his home) his partner's. */
  private mover(seat: Seat) {
    if (!this.teams || !this.done(seat)) return seat;
    return this.seats[(this.seats.indexOf(seat) + 2) % 4];
  }

  private startTurn(id: string, extraMs = 0) {
    this.turn = id;
    this.sixes = 0;
    this.awaitRoll(extraMs);
  }

  /** The player rolls (again). */
  private awaitRoll(extraMs = 0) {
    this.step = "roll";
    this.dice = 0;
    this.arm(extraMs);
  }

  private arm(extraMs: number) {
    this.timer?.clear();
    this.botTimer?.clear();
    this.turnEndsAt = Date.now() + extraMs + this.turnSeconds * 1000;
    this.timer = this.clock.setTimeout(() => (this.timeOut(), this.sync()), extraMs + this.turnSeconds * 1000);
    const seat = this.seat(this.turn);
    if (seat?.bot || seat?.auto) this.botAct(this.turn, extraMs);
  }

  private handleRoll(id: string, aim: Aim = {}) {
    if (this.phase !== "playing" || this.turn !== id || this.step !== "roll") return;
    const seat = this.seat(id)!;
    const roll = 1 + Math.floor(Math.random() * 6);
    this.dice = roll;
    const lost = roll === 6 && ++this.sixes === 3; // three 6s: the turn is lost
    const options = lost ? [] : movable(this.mover(seat).pawns, roll);
    const thrown = this.throwFrom(aim);
    this.die = { x: thrown.x, y: thrown.y, value: roll };
    this.broadcast("ludo_fx", {
      type: "roll", who: id, value: roll, lost, stuck: !lost && options.length === 0,
      path: thrown.path, spin: Math.floor(Math.random() * 1e9),
    });
    const shown = thrown.ms + LANDED_MS;
    if (lost) return this.wait(shown + NO_MOVE_MS, () => this.nextTurn());
    if (options.length === 0) {
      return this.wait(shown + NO_MOVE_MS, () => (roll === 6 ? this.awaitRoll() : this.nextTurn()));
    }
    this.step = "move";
    // One way to go, nobody to catch or spare: it goes by itself.
    if (options.length === 1 && (this.capture === "auto" || this.caught(seat, options[0]).length === 0)) {
      return this.wait(shown, () => this.move(seat, options[0], true));
    }
    this.arm(shown);
  }

  /** The die flies from where it lies: along the player's swipe, or (a tap, a bot) more or less toward the middle. */
  private throwFrom({ dx, dy, power }: Aim) {
    const { x, y } = this.die;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx!, dy!) < 1e-3) {
      const angle = Math.atan2(7.5 - y, 7.5 - x) + (Math.random() - 0.5) * 2.2;
      return throwDie(x, y, Math.cos(angle), Math.sin(angle), 0.35 + Math.random() * 0.45);
    }
    return throwDie(x, y, dx!, dy!, Number.isFinite(power) ? power! : 0.5);
  }

  private caught(seat: Seat, pawn: number) {
    const m = this.mover(seat);
    const to = target(m.pawns[pawn], this.dice);
    return to === null ? [] : victims(this.board(), m.color, to, (c) => this.friends(m.color, c));
  }

  /** Nobody acts for a moment (the dice tumble, the pawn hops); then [then]. */
  private wait(ms: number, then: () => void) {
    this.step = "wait";
    this.timer?.clear();
    this.botTimer?.clear();
    this.turnEndsAt = 0;
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms * LudoRoom.botSpeed);
  }

  private handleMove(id: string, pawn: number, capture: boolean) {
    if (this.phase !== "playing" || this.turn !== id || this.step !== "move") return;
    const seat = this.seat(id)!;
    const from = this.mover(seat).pawns[pawn];
    if (from === undefined || target(from, this.dice) === null) return "cant_move";
    this.move(seat, pawn, capture);
  }

  private move(seat: Seat, pawn: number, capture: boolean) {
    const id = seat.id;
    const m = this.mover(seat);
    const from = m.pawns[pawn];
    const to = target(from, this.dice)!;
    const caught = capture || this.capture === "auto" ? this.caught(seat, pawn) : [];
    m.pawns[pawn] = to;
    for (const v of caught) this.seats.find((s) => s.color === v.color)!.pawns[v.pawn] = -1;
    this.broadcast("ludo_fx", { type: "move", who: id, color: m.color, pawn, from, to, caught });
    const hops = from < 0 ? 1 : to - from;
    const again = caught.length > 0 || to === HOME || this.dice === 6;
    this.dice = 0;
    if (this.finished()) return;
    const after = hops * HOP_MS + (caught.length ? 500 : 150);
    // Rolls again (a 6, a catch, a pawn home) — unless he's out of the race.
    if (again && !(this.done(seat) && this.done(this.mover(seat)))) this.wait(after, () => this.awaitRoll());
    else this.wait(after, () => this.nextTurn());
  }

  /** Who just got all his pawns home takes his place; the game ends when the race is decided. */
  private finished() {
    for (const s of this.seats) if (this.done(s) && !this.places.includes(s.id)) this.places.push(s.id);
    const over = this.teams
      ? [0, 1].some((t) => this.seats.filter((_, i) => i % 2 === t).every((s) => this.done(s)))
      : this.places.length >= this.seats.length - 1;
    if (!over) return false;
    for (const s of this.seats) if (!this.places.includes(s.id)) this.places.push(s.id);
    this.phase = "gameover";
    this.turn = "";
    this.turnEndsAt = 0;
    this.timer?.clear();
    this.botTimer?.clear();
    this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
    return true;
  }

  private nextTurn() {
    const i = this.seats.findIndex((s) => s.id === this.turn);
    for (let k = 1; k <= this.seats.length; k++) {
      const s = this.seats[(i + k) % this.seats.length];
      if (!this.done(s) || !this.done(this.mover(s))) return this.startTurn(s.id);
    }
  }

  /** Out of time: the roll is made for him, or the move a normal bot would make. */
  private timeOut() {
    if (this.phase !== "playing") return;
    const id = this.turn;
    if (this.step === "roll") this.handleRoll(id);
    else if (this.step === "move") this.handleMove(id, this.pick(id, "normal"), true);
  }

  private pick(id: string, level: BotLevel) {
    const m = this.mover(this.seat(id)!);
    return botMove(level, this.board(), m.color, this.dice, (c) => this.friends(m.color, c)) ?? 0;
  }

  // ---- bots (and auto play) ----

  private botAct(id: string, delayMs: number) {
    this.botTimer?.clear();
    const seat = this.seat(id)!;
    const think = seat.auto ? 350 : 600 + Math.random() * 700;
    this.botTimer = this.clock.setTimeout(() => {
      if (this.turn !== id || this.phase !== "playing") return;
      if (this.step === "roll") this.handleRoll(id);
      else if (this.step === "move") this.handleMove(id, this.pick(id, seat.bot ?? "hard"), true);
      this.sync();
    }, (delayMs + think) * LudoRoom.botSpeed);
  }

  // ---- sync ----

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private updateListing() {
    this.setMatchmaking({
      metadata: {
        host: this.seat(this.hostId)?.name ?? "",
        roomType: this.roomType,
        started: this.phase !== "lobby",
        players: this.seats.length,
        maxPlayers: this.maxPlayers,
        spectators: 0,
      },
    });
  }

  private sync() {
    const lobbyColors = colorsFor(Math.max(2, this.seats.length));
    const turnSeat = this.seat(this.turn);
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      maxPlayers: this.maxPlayers,
      turnSeconds: this.turnSeconds,
      capture: this.capture,
      pawns: this.pawnCount,
      teams: this.teams,
      seats: this.seats.map((s, i) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, connected: s.connected, bot: s.bot ?? "", auto: s.auto,
        color: this.phase === "lobby" ? lobbyColors[i] ?? i : s.color, pawns: s.pawns, team: this.teams ? i % 2 : -1,
      })),
      turn: this.turn,
      step: this.step,
      dice: this.dice,
      die: [this.die.x, this.die.y, this.die.value],
      moveColor: turnSeat ? this.mover(turnSeat).color : -1,
      turnEndsAt: this.turnEndsAt,
      places: this.places,
      serverNow: Date.now(),
    };
    for (const client of this.clients) client.send("ludo", { ...table, me: client.sessionId });
  }
}
