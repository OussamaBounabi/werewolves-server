import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { canMate, chessBotMove, chessBotTakesDraw, chessEnd, inCheck, kingOf, legalMoves, makeMove, posKey, startPos, type ChessPos } from "../chess.js";
import {
  checkersBotMove, checkersBotTakesDraw, checkersEnd, checkersKey, checkersMoves, checkersPlay, checkersStart, sameMove, type CheckersPos,
} from "../checkers.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSeat, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";

/**
 * Chess & Checkers: one table, two players (one may be a bot the host seats, easy, normal or hard); the host picks
 * the game in the waiting room (lib/chess in the app). The server holds the rules (src/chess.ts, src/checkers.ts)
 * and the clocks: each player has his own time for the whole game (plus an increment per move), running only on his
 * turn; at 0 he loses (a draw if the other can't checkmate any more). Resign, draw offers, takebacks (when the room
 * allows them). A player who leaves mid-game loses it.
 *
 * No schema: "chess" (the table) after every change, with the moves the side to move may play; "chess_fx" to one
 * player (his offer refused); "chess_error". The table's chat, emojis and voice, as at the other tables.
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number; variant: string };
type Settings = {
  roomType?: string; variant?: string; minutes?: number; increment?: number; color?: string;
  takebacks?: boolean; forced?: boolean; swap?: boolean;
};
type JoinOptions = Settings & { admin?: boolean; name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type BotLevel = "easy" | "normal" | "hard";
type Color = 0 | 1;
type Seat = {
  id: string; playerId: string; name: string; uid: string; avatar: number; frame: number; vip?: string;
  connected: boolean; bot: BotLevel | null; left: boolean;
};
type Phase = "lobby" | "playing" | "gameover";
type Last = { from: number; to: number; path?: number[]; captures?: number[]; capture: boolean; castle: boolean; promo?: string; crowned: boolean; check: boolean };
type Snapshot = { chess: ChessPos; checkers: CheckersPos; last: Last | null; keys: number };

const SEATS = 2;
const ROOM_TYPES = ["public", "friends", "private"];
const VARIANTS = ["chess", "checkers"];
const MINUTES = [1, 3, 5, 10, 15];
const INCREMENTS = [0, 2, 5];
const COLORS = ["random", "white", "black"];
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
const LATE_MS = 400; // a move may arrive this late after a clock ran out (the network)
const RECONNECT_SECONDS = 60; // a dropped player gone over a minute is out: he loses
const CLOSE_AFTER_GAME_MS = 60_000;
const MAX_SPECTATORS = 20;

const added = (s: Seat) => s.id.startsWith("bot-");

export class ChessRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this);
  static botSpeed = 1; // tests: bots think faster
  maxClients = SEATS + MAX_SPECTATORS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private variant = "chess";
  private minutes = 5;
  private increment = 0;
  private color = "random"; // the host's
  private takebacks = false;
  private forced = true; // checkers: a capture must be taken
  private swap = true; // play again: colors change sides
  private seats: Seat[] = [];
  private members = new Map<string, string>();
  private invited = new Set<string>();
  private banned = new Map<string, string>();
  private spectators = new Map<string, JoinOptions>();
  private admins = new Set<string>();
  private tableTalk!: TableTalk;
  private returned = new Map<string, string>();
  private listedStarted = false;
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" };
  private kicks = new Kicks(this);
  private looks = new RoomLooks();
  private get look() {
    return this.looks.of(this.hostId);
  }

  // the game
  private whiteSeat = 0; // the seat playing white (checkers: the white pieces; black moves first there)
  private lastWhiteSeat = -1;
  private chess: ChessPos = startPos();
  private checkers: CheckersPos = checkersStart();
  private keys: string[] = []; // every position so far (repetitions)
  private history: Snapshot[] = []; // before each move (takebacks)
  private last: Last | null = null;
  private clocks: [number, number] = [0, 0]; // ms left, white's and black's, at the start of this turn
  private turnStartedAt = 0;
  private offer: { type: "draw" | "takeback"; by: string } | null = null;
  private drawAskedAt = new Map<string, number>(); // the ply of each player's last draw offer (one per move)
  private result: { winner: Color | null; reason: string } | null = null;
  private ready = new Set<string>();
  private botSeq = 0;
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("chess_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && this.idOf(c) === this.hostId) this.applySettings(m);
    });
    on<{ level: string }>("add_bot", (c, m) => this.handleAddBot(c, m.level));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on("sit", (c) => this.handleSit(c));
    on<Record<string, unknown>>("move", (c, m) => this.handleMove(this.idOf(c), m));
    on("resign", (c) => this.handleResign(this.idOf(c)));
    on("draw", (c) => this.handleDrawOffer(c));
    on("takeback", (c) => this.handleTakeback(c));
    on<{ yes?: boolean }>("answer", (c, m) => this.handleAnswer(this.idOf(c), m.yes === true));
    on("play_again", (c) => this.handlePlayAgain(this.idOf(c)));
    on<{ id: string }>("kick", (c, m) => void this.handleKick(c, m.id));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.tableTalk = new TableTalk(this, (c) => this.seat(this.idOf(c)), (c) => this.idOf(c));
    this.onMessage("room_look", (client, msg) => this.handleLook(client, msg));
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (!this.seat(this.idOf(client)) || typeof msg?.uid !== "string") return;
      this.invited.add(msg.uid);
      if (this.idOf(client) === this.hostId) this.banned.delete(msg.uid);
    });
    this.updateListing();
  }

  // ---- joining (as at the billiard table) ----

  async onAuth(_client: Client, options: JoinOptions = {}): Promise<{ account: Account | null; admin?: boolean }> {
    if (options.admin) {
      if (!options.idToken || !(await isAdmin(String(options.idToken)))) throw new ServerError(4403, "admin");
      return { account: null, admin: true };
    }
    let account: Account | null = null;
    if (options.idToken && accountsEnabled) {
      try {
        account = await accountFor(String(options.idToken));
      } catch {
        throw new ServerError(4401, "auth");
      }
    }
    const kicker = this.banned.get(account?.uid ?? String(options.playerId ?? ""));
    if (kicker && this.seats.some((s) => s.playerId === kicker)) throw new ServerError(4403, "banned");
    if (options.spectator) {
      if (this.phase === "lobby") throw new ServerError(4409, "lobby");
      if (this.spectators.size >= MAX_SPECTATORS) throw new ServerError(4409, "full");
    } else {
      if (this.phase !== "lobby") throw new ServerError(4409, "started");
      if (this.seats.length >= SEATS) throw new ServerError(4409, "full");
    }
    if (this.roomType !== "public" && !this.seats.every((s) => s.bot)) {
      const ok =
        (account && this.invited.has(account.uid)) ||
        (this.roomType === "friends" && account && (await isFriendOfAny(account.uid, [...new Set(this.members.values())])));
      if (!ok) throw new ServerError(4410, this.roomType === "private" ? "private" : "friends");
    }
    return { account };
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    if (client.auth?.admin) {
      this.admins.add(client.sessionId);
      this.tableTalk.history(client);
      return this.sync();
    }
    const account: Account | null = client.auth?.account ?? null;
    this.looks.join(this.idOf(client), client.auth?.account);
    if (account) {
      this.members.set(this.idOf(client), account.uid);
      enterRoom(account.uid, this.roomName, this.roomId);
    }
    if (options.spectator) this.spectators.set(this.idOf(client), options);
    else this.addSeat(client, options);
    this.tableTalk.history(client);
    this.updateListing();
    this.sync();
  }

  private addSeat(client: Client, options: JoinOptions) {
    const account: Account | null = client.auth?.account ?? null;
    const playerId = account?.uid ?? String(options.playerId ?? this.idOf(client));
    const ghost = this.seats.find((s) => s.playerId === playerId);
    if (ghost) this.removeSeat(ghost.id);
    this.seats.push({
      id: this.idOf(client),
      playerId,
      name: account?.name ?? (String(options.name ?? "").trim().slice(0, 24) || `Player-${this.idOf(client).slice(0, 4)}`),
      uid: account?.uid ?? "",
      avatar: account?.avatar ?? randomAvatar(),
      frame: account?.frame ?? randomFrame(),
      vip: vipLevel(account),
      connected: true,
      bot: null,
      left: false,
    });
    if (!this.hostId) this.hostId = this.idOf(client);
  }

  private handleSit(client: Client) {
    const options = this.spectators.get(this.idOf(client));
    if (this.phase !== "lobby" || !options) return;
    if (this.seats.length >= SEATS) return "full";
    this.spectators.delete(this.idOf(client));
    this.addSeat(client, options);
    if (voiceEnabled) setVoiceRights(this.roomId, this.idOf(client), { talk: true, hear: true }).catch(() => {});
    this.updateListing();
  }

  private idOf(client: Client) {
    return this.returned.get(client.sessionId) ?? client.sessionId;
  }

  private connectionOf(id: string) {
    for (const [session, seat] of this.returned) if (seat === id) return this.clients.getById(session);
    return this.clients.getById(id);
  }

  onDrop(client: Client) {
    if (this.admins.has(client.sessionId) || this.spectators.has(this.idOf(client))) return holdSpectator(this, client);
    const seat = this.seat(this.idOf(client));
    if (seat) seat.connected = false;
    holdSeat(this, client, RECONNECT_SECONDS);
    this.sync();
  }

  onReconnect(client: Client) {
    const seat = this.seat(this.idOf(client));
    if (!seat && !this.spectators.has(this.idOf(client)) && !this.admins.has(client.sessionId)) {
      client.leave(4000);
      return;
    }
    if (seat) seat.connected = true;
    this.tableTalk.history(client);
    this.sync();
  }

  onLeave(client: Client) {
    if (this.admins.delete(client.sessionId)) {
      if (voiceEnabled) dropFromVoice(this.roomId, client.sessionId).catch(() => {});
      return;
    }
    const id = this.idOf(client);
    this.returned.delete(client.sessionId);
    const uid = this.members.get(id);
    this.members.delete(id);
    if (uid) leaveRoom(uid, this.roomId);
    if (voiceEnabled) dropFromVoice(this.roomId, id).catch(() => {});
    if (this.spectators.delete(id)) {
      this.updateListing();
      return this.sync();
    }
    if (this.abandon.closing) return;
    const seat = this.seat(id);
    if (this.phase === "lobby") this.removeSeat(id);
    else if (seat) {
      seat.left = true;
      seat.connected = false;
      if (this.phase === "playing") this.finish((1 - this.colorOf(seat)) as Color, "abandon");
    }
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && !s.left && this.connectionOf(s.id))?.id ?? "";
    this.afterGame(false);
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
    if (this.admins.has(client.sessionId)) { // the admin listens, unseen
      return client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, "admin", { talk: false, hear: true }, false, true)) });
    }
    const name = this.seat(this.idOf(client))?.name ?? client.auth?.account?.name ?? "spectator";
    // Players talk; of those watching, only VIP Pro.
    const talk = !!this.seat(this.idOf(client)) || client.auth?.account?.vipPro === true;
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, this.idOf(client), name, { talk, hear: true })) });
  }

  // ---- the waiting room ----

  private applySettings(s: Settings) {
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (VARIANTS.includes(s.variant as string)) this.variant = s.variant as string;
    if (MINUTES.includes(Number(s.minutes))) this.minutes = Number(s.minutes);
    if (INCREMENTS.includes(Number(s.increment))) this.increment = Number(s.increment);
    if (COLORS.includes(s.color as string)) this.color = s.color as string;
    if (typeof s.takebacks === "boolean") this.takebacks = s.takebacks;
    if (typeof s.forced === "boolean") this.forced = s.forced;
    if (typeof s.swap === "boolean") this.swap = s.swap;
    this.updateListing();
  }

  private handleAddBot(client: Client, level: string) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || this.seats.length >= SEATS) return;
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
      bot: BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : "normal",
      left: false,
    });
    this.updateListing();
  }

  private handleRemoveBot(client: Client, id: string) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || !this.seat(id)?.bot) return;
    this.removeSeat(id);
    this.updateListing();
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId) return;
    if (this.seats.length < SEATS) return "not_enough_players";
    this.lastWhiteSeat = -1; // (the host's color applies to a first game)
    this.newGame();
  }

  private async handleKick(client: Client, id: string) {
    const seat = this.seat(id), by = this.seat(this.idOf(client));
    if (this.phase !== "lobby" || !by || !seat || seat === by || !!seat.bot) return;
    const how = await this.kicks.decide(by, by.name, by.id === this.hostId, seat, this.connectionOf(id));
    if (typeof how === "object") return client.send("chess_error", how);
    if (this.phase !== "lobby" || !this.seat(id)) return;
    if (how === "kicked") this.banned.set(seat.playerId, by.playerId);
    const kicked = this.connectionOf(id);
    if (how === "kicked") kicked?.send("kicked");
    this.removeSeat(id);
    this.updateListing();
    kicked?.leave(4000);
    this.sync();
  }

  private handleLook(client: Client, msg: unknown) {
    if (this.idOf(client) !== this.hostId || !this.looks.set(this.hostId, msg)) return;
    this.updateListing();
  }

  /** Support banned this player: out at once (mid-game he loses it). */
  removeBanned(uid: string) {
    for (const [id, member] of this.members) {
      if (member !== uid) continue;
      const seat = this.seat(id);
      if (seat) this.broadcast("removed", { name: seat.name });
      this.connectionOf(id)?.leave(4000);
    }
  }

  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.seats.splice(index, 1);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot)?.id ?? "";
  }

  // ---- the game ----

  private colorOf(seat: Seat): Color {
    return this.seats.indexOf(seat) === this.whiteSeat ? 0 : 1;
  }

  private seatOf(color: Color) {
    return this.seats[color === 0 ? this.whiteSeat : 1 - this.whiteSeat];
  }

  private get turn(): Color {
    return this.variant === "chess" ? this.chess.turn : this.checkers.turn;
  }

  private get plies() {
    return this.history.length;
  }

  private newGame() {
    const host = Math.max(0, this.seats.findIndex((s) => s.id === this.hostId));
    if (this.swap && this.lastWhiteSeat >= 0) this.whiteSeat = 1 - this.lastWhiteSeat;
    else if (this.color === "white") this.whiteSeat = host;
    else if (this.color === "black") this.whiteSeat = 1 - host;
    else this.whiteSeat = Math.random() < 0.5 ? 0 : 1;
    this.lastWhiteSeat = this.whiteSeat;
    this.phase = "playing";
    this.chess = startPos();
    this.checkers = checkersStart();
    this.keys = [this.key()];
    this.history = [];
    this.last = null;
    this.offer = null;
    this.drawAskedAt.clear();
    this.result = null;
    this.clocks = [this.minutes * 60_000, this.minutes * 60_000];
    this.ready.clear();
    this.updateListing();
    this.startTurn();
  }

  private key() {
    return this.variant === "chess" ? posKey(this.chess) : checkersKey(this.checkers);
  }

  private startTurn() {
    this.turnStartedAt = Date.now();
    this.timer?.clear();
    this.botTimer?.clear();
    this.timer = this.clock.setTimeout(() => (this.flag(), this.sync()), this.clocks[this.turn] + LATE_MS);
    const seat = this.seatOf(this.turn);
    if (seat?.bot) this.botTurn(seat.bot);
  }

  /** The clock of the side to move ran out. */
  private flag() {
    if (this.phase !== "playing") return;
    const loser = this.turn, winner = (1 - loser) as Color;
    this.clocks[loser] = 0;
    const draw = this.variant === "chess" && !canMate(this.chess.board, winner);
    this.finish(draw ? null : winner, draw ? "time_material" : "time");
  }

  private botTurn(level: BotLevel) {
    // It thinks like a person, a little longer when it has the time (never more than a twentieth of what it has left).
    const think = Math.min(400 + Math.random() * 1200, this.clocks[this.turn] / 20) * ChessRoom.botSpeed;
    this.botTimer = this.clock.setTimeout(() => {
      const seat = this.seatOf(this.turn);
      if (this.phase !== "playing" || !seat?.bot) return;
      // ponytail: the bot's search (up to 1.5 s at hard) blocks the server's loop; a worker if rooms pile up
      if (this.variant === "chess") this.playChess(chessBotMove(this.chess, level));
      else this.playCheckers(checkersBotMove(this.checkers, level, this.forced));
      this.sync();
    }, think);
  }

  /** A player's move: his turn, his clock not run out, and a legal move. */
  private handleMove(id: string, m: Record<string, unknown>) {
    const seat = this.phase === "playing" ? this.seatOf(this.turn) : undefined;
    if (!seat || seat.id !== id || seat.bot) return "not_your_turn";
    if (Date.now() - this.turnStartedAt > this.clocks[this.turn] + LATE_MS) return "too_late";
    if (this.variant === "chess") {
      const promo = typeof m.promo === "string" ? m.promo : undefined;
      const move = legalMoves(this.chess).find((x) => x.from === m.from && x.to === m.to && x.promo === promo);
      if (!move) return "illegal";
      this.playChess(move);
    } else {
      const path = Array.isArray(m.path) ? m.path.map(Number) : [];
      const move = checkersMoves(this.checkers, this.forced).find((x) => sameMove(x, path));
      if (!move) return "illegal";
      this.playCheckers(move);
    }
  }

  /** The time the mover took comes off his clock, his increment goes on; a move refuses the other's pending offer. */
  private beforeMove() {
    const t = this.turn;
    this.clocks[t] = Math.max(0, this.clocks[t] - (Date.now() - this.turnStartedAt)) + this.increment * 1000;
    this.history.push({ chess: this.chess, checkers: this.checkers, last: this.last, keys: this.keys.length });
    const mover = this.seatOf(t);
    if (this.offer && (this.offer.type === "takeback" || this.offer.by !== mover?.id)) this.offer = null;
  }

  private playChess(m: { from: number; to: number; promo?: string }) {
    this.beforeMove();
    const before = this.chess;
    const piece = before.board[m.from].toLowerCase();
    this.chess = makeMove(before, m);
    this.last = {
      from: m.from, to: m.to, ...(m.promo ? { promo: m.promo } : {}), crowned: false, // (no undefined: the apps' msgpack refuses it)
      capture: before.board[m.to] !== "" || (piece === "p" && m.to === before.ep),
      castle: piece === "k" && Math.abs(m.to - m.from) === 2,
      check: inCheck(this.chess),
    };
    this.keys.push(this.key());
    const end = chessEnd(this.chess, this.keys);
    if (end) this.finish(end.winner, end.end);
    else this.startTurn();
  }

  private playCheckers(m: { path: number[]; captures: number[] }) {
    this.beforeMove();
    const before = this.checkers;
    const from = m.path[0], to = m.path[m.path.length - 1];
    this.checkers = checkersPlay(before, m);
    this.last = {
      from, to, path: m.path, captures: m.captures, capture: m.captures.length > 0, castle: false, check: false,
      crowned: before.board[from] !== this.checkers.board[to],
    };
    this.keys.push(this.key());
    const end = checkersEnd(this.checkers, this.keys, this.forced);
    if (end) this.finish(end.winner, end.end);
    else this.startTurn();
  }

  private handleResign(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "playing" || !seat || seat.bot) return;
    this.finish((1 - this.colorOf(seat)) as Color, "resign");
  }

  private opponent(seat: Seat) {
    return this.seats.find((s) => s !== seat);
  }

  /** A draw offer: the bot answers at once (yes when it's behind); a player answers with "answer". One per move. */
  private handleDrawOffer(client: Client): string | void {
    const seat = this.seat(this.idOf(client));
    if (this.phase !== "playing" || !seat || seat.bot || this.offer) return;
    if (this.drawAskedAt.get(seat.id) === this.plies) return "asked";
    this.drawAskedAt.set(seat.id, this.plies);
    const other = this.opponent(seat);
    if (other?.bot) {
      const color = this.colorOf(other);
      const yes = this.variant === "chess" ? chessBotTakesDraw(this.chess, color) : checkersBotTakesDraw(this.checkers, color);
      if (yes) return void this.finish(null, "agreed");
      return void client.send("chess_fx", { type: "declined", what: "draw" });
    }
    this.offer = { type: "draw", by: seat.id };
  }

  /** Asking to take back my last move (when the room allows it): the bot always agrees. */
  private handleTakeback(client: Client): string | void {
    const seat = this.seat(this.idOf(client));
    if (this.phase !== "playing" || !seat || seat.bot || this.offer || !this.takebacks) return;
    if (!this.history.some((_, i) => this.moverAt(i) === this.colorOf(seat))) return; // he hasn't moved yet
    if (this.opponent(seat)?.bot) return void this.takeBack(seat);
    this.offer = { type: "takeback", by: seat.id };
  }

  /** Who made the move at ply [i]. */
  private moverAt(i: number): Color {
    const first: Color = this.variant === "chess" ? 0 : 1;
    return (i % 2 === 0 ? first : 1 - first) as Color;
  }

  /** Back to [seat]'s turn before his last move (his move, and the other's answer if there was one). */
  private takeBack(seat: Seat) {
    const color = this.colorOf(seat);
    do {
      const snap = this.history.pop()!;
      this.chess = snap.chess;
      this.checkers = snap.checkers;
      this.last = snap.last;
      this.keys.length = snap.keys;
    } while (this.history.length > 0 && this.turn !== color);
    this.offer = null;
    this.startTurn();
  }

  private handleAnswer(id: string, yes: boolean) {
    const offer = this.offer, seat = this.seat(id), by = offer && this.seat(offer.by);
    if (this.phase !== "playing" || !offer || !seat || !by || seat === by) return;
    this.offer = null;
    if (!yes) {
      this.connectionOf(by.id)?.send("chess_fx", { type: "declined", what: offer.type });
      return;
    }
    if (offer.type === "draw") this.finish(null, "agreed");
    else this.takeBack(by);
  }

  private finish(winner: Color | null, reason: string) {
    if (this.phase !== "playing") return;
    // Ended between moves: the time spent on this turn comes off the clock that was running.
    if (reason === "resign" || reason === "agreed" || reason === "abandon") {
      this.clocks[this.turn] = Math.max(0, this.clocks[this.turn] - (Date.now() - this.turnStartedAt));
    }
    this.result = { winner, reason };
    this.phase = "gameover";
    this.offer = null;
    this.timer?.clear();
    this.botTimer?.clear();
    this.ready = new Set(this.seats.filter(added).map((s) => s.id));
    this.turnStartedAt = Date.now();
    this.timer = this.clock.setTimeout(() => (this.afterGame(true), this.sync()), CLOSE_AFTER_GAME_MS);
  }

  // ---- after a game (as at the billiard table) ----

  private handlePlayAgain(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "gameover" || !seat || seat.bot || seat.left) return;
    this.ready.add(id);
    this.afterGame(false);
  }

  private afterGame(timeUp: boolean) {
    if (this.phase !== "gameover") return;
    const players = this.seats.filter((s) => !added(s));
    if (!timeUp && players.some((s) => !s.left && !this.ready.has(s.id))) return;
    this.timer?.clear();
    const again = players.filter((s) => !s.left && this.ready.has(s.id));
    if (again.length === 0) {
      this.abandon.closing = true;
      return void this.disconnect().catch(() => {});
    }
    if (again.length === players.length) {
      gameStarted(this.roomName);
      return this.newGame();
    }
    for (const s of [...this.seats]) {
      if (added(s) || again.includes(s)) continue;
      const client = this.connectionOf(s.id);
      this.removeSeat(s.id);
      client?.leave(4000);
    }
    if (!this.seat(this.hostId)) this.hostId = again[0].id;
    this.ready.clear();
    this.lastWhiteSeat = -1;
    this.phase = "lobby";
    this.updateListing();
  }

  // ---- sync ----

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private updateListing() {
    if (!this.listedStarted && this.phase !== "lobby") gameStarted(this.roomName);
    this.listedStarted = this.phase !== "lobby";
    const host = this.seat(this.hostId);
    if (host && (this.phase === "lobby" || !this.listedHost.name)) {
      this.listedHost = { name: host.name, avatar: host.avatar, frame: host.frame, vip: host.vip ?? "" };
    }
    this.setMatchmaking({
      metadata: {
        host: this.listedHost.name,
        hostAvatar: this.listedHost.avatar,
        hostFrame: this.listedHost.frame,
        hostVip: this.listedHost.vip,
        roomName: this.look.name,
        roomStyle: this.look.style,
        roomType: this.roomType,
        started: this.phase !== "lobby",
        players: this.seats.length,
        maxPlayers: SEATS,
        spectators: this.spectators.size,
        variant: this.variant,
      },
    });
  }

  /** The moves the side to move may play: chess [from, to, promo?], checkers the squares each one goes through. */
  private moves() {
    if (this.phase !== "playing") return [];
    if (this.variant === "chess") return legalMoves(this.chess).map((m) => (m.promo ? [m.from, m.to, m.promo] : [m.from, m.to]));
    return checkersMoves(this.checkers, this.forced).map((m) => m.path);
  }

  private sync() {
    this.abandon.check(this.seats);
    if ((this.phase !== "lobby") !== this.listedStarted) this.updateListing();
    const chess = this.variant === "chess";
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      variant: this.variant,
      minutes: this.minutes,
      increment: this.increment,
      color: this.color,
      takebacks: this.takebacks,
      forced: this.forced,
      swap: this.swap,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected && !s.left,
        bot: s.bot ?? "", color: this.phase === "lobby" ? -1 : this.colorOf(s),
      })),
      board: chess ? this.chess.board : this.checkers.board,
      turn: this.turn,
      check: chess && this.phase !== "lobby" && inCheck(this.chess) ? kingOf(this.chess.board, this.chess.turn) : -1,
      moves: this.moves(),
      last: this.last,
      plies: this.plies,
      clocks: this.clocks,
      turnStartedAt: this.turnStartedAt,
      serverNow: Date.now(),
      offer: this.offer,
      result: this.result,
      ready: [...this.ready],
      spectators: this.spectators.size,
    };
    for (const client of this.clients) client.send("chess", { ...table, me: this.idOf(client) });
  }
}
