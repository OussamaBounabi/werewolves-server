import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { botPlan, EightBall, freeSpot, rack, Sim, tune, type Ball, type Shot } from "../billiard.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";

/**
 * 8-ball, two players (one may be a bot the host seats, easy, normal or hard), as in the app (lib/billiard). The server
 * plays every shot in its own copy of the app's physics (src/billiard.ts: the same to the last bit) and is the
 * table's truth: a player sends his shot, the server plays it, applies the rules and sends everyone the shot with
 * where the balls ended; each app plays it on screen and lands on those same places. While a player aims, his aim is
 * passed on to the others as it moves ("aim").
 *
 * No schema: "billiard" (the table) after every change, "billiard_shot" for each shot, "billiard_aim" for an aim,
 * "billiard_fx" for a shot clock that ran out. The table's chat, emojis and voice, as at the other tables. Each player
 * plays with his own cue ("cue"): the others see it while he aims.
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type Settings = { roomType?: string; turnSeconds?: number };
type JoinOptions = Settings & { admin?: boolean; name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type BotLevel = "easy" | "normal" | "hard";
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number;
  vip?: string;
  connected: boolean;
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a normal bot
  cue: string; // his cue (the app's assets/images/billiard/cues/<cue>.webp)
};
type Phase = "lobby" | "playing" | "gameover";

const SEATS = 2;
const ROOM_TYPES = ["public", "friends", "private"];
const TURN_OPTIONS = [15, 30, 45, 60];
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_SKILL: Record<BotLevel, number> = { easy: 0.2, normal: 0.5, hard: 0.85 }; // how little its aim wobbles
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
// The apps' animations, so the next turn starts once a shot is over on screen: a player's stroke; the bot's (the cue
// ball placed, the cue turned, drawn back, then the stroke); time to settle (pots, the message) and for slow phones.
const STROKE_MS = 70;
const BOT_AIM_MS = 2020;
const SETTLE_MS = 900;
const LATE_MS = 1000; // a shot may arrive this late after the clock ran out (the network)
const RECONNECT_SECONDS = 60; // a dropped player gone over a minute is out, as if he had left
const CLOSE_AFTER_GAME_MS = 60_000;
const MAX_SPECTATORS = 20;
const CUES = ["default", "navy", "gold", "royal"];

const added = (s: Seat) => s.id.startsWith("bot-");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

export class BilliardRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this);
  static botSpeed = 1; // tests: bots think faster
  maxClients = SEATS + MAX_SPECTATORS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private turnSeconds = 30;
  private seats: Seat[] = []; // seat index = the player number in the rules (0 or 1)
  private members = new Map<string, string>();
  private invited = new Set<string>();
  private banned = new Map<string, string>();
  private spectators = new Map<string, JoinOptions>();
  private admins = new Set<string>();
  private tableTalk!: TableTalk; // the table's chat and emojis
  private returned = new Map<string, string>();
  private listedStarted = false;
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" };
  private kicks = new Kicks(this); // who may put whom out of the waiting room (a VIP Pro may choose to stay)
  private looks = new RoomLooks();
  private get look() {
    return this.looks.of(this.hostId);
  }

  private game = new EightBall();
  private balls: Ball[] = rack(); // the cue ball always first
  private shots = 0;
  private lastLoser = -1; // he breaks the next game
  private turnStartsAt = 0; // the last shot is over on screen: the player may shoot
  private turnEndsAt = 0;
  private ready = new Set<string>();
  private botSeq = 0;
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("billiard_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && this.idOf(c) === this.hostId) this.applySettings(m);
    });
    on<{ level: string }>("add_bot", (c, m) => this.handleAddBot(c, m.level));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on("sit", (c) => this.handleSit(c));
    on<Record<string, unknown>>("shot", (c, m) => this.handleShot(this.idOf(c), m));
    on("play_again", (c) => this.handlePlayAgain(this.idOf(c)));
    on<{ id: string }>("kick", (c, m) => void this.handleKick(c, m.id));
    on<{ id: string }>("cue", (c, m) => {
      const seat = this.seat(this.idOf(c));
      if (seat && CUES.includes(m.id)) seat.cue = m.id;
    });
    this.onMessage("aim", (client, m: Record<string, unknown>) => this.handleAim(client, m ?? {}));
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

  // ---- joining (as at the domino table) ----

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
    if (this.seatLeftBy(account?.uid ?? String(options.playerId ?? ""))) return { account };
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
    const back = this.seatLeftBy(account?.uid ?? String(options.playerId ?? ""));
    if (back) this.returned.set(client.sessionId, back.id);
    this.looks.join(this.idOf(client), client.auth?.account);
    if (account) {
      this.members.set(this.idOf(client), account.uid);
      enterRoom(account.uid, this.roomName, this.roomId);
    }
    if (back) this.retakeSeat(back);
    else if (options.spectator) this.spectators.set(this.idOf(client), options);
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
      cue: "default",
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

  private seatLeftBy(playerId: string) {
    if (this.phase === "lobby" || !playerId) return undefined;
    return this.seats.find((s) => s.playerId === playerId && !!s.bot);
  }

  private retakeSeat(seat: Seat) {
    seat.bot = null;
    seat.connected = true;
    if (this.turnSeat()?.id === seat.id) this.botTimer?.clear(); // his turn: his to play, in the time left
  }

  onDrop(client: Client) {
    if (this.admins.has(client.sessionId) || this.spectators.has(this.idOf(client))) return holdSpectator(this, client);
    const seat = this.seat(this.idOf(client));
    if (seat) seat.connected = false;
    Promise.resolve(this.allowReconnection(client, RECONNECT_SECONDS)).catch(() => {});
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
    if (this.phase === "lobby") this.removeSeat(id);
    else this.becomeBot(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && this.connectionOf(s.id))?.id ?? "";
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
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
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
      cue: CUES[1 + Math.floor(Math.random() * (CUES.length - 1))], // a bot plays with one of the fine cues
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
    this.newGame();
  }

  private async handleKick(client: Client, id: string) {
    const seat = this.seat(id), by = this.seat(this.idOf(client));
    if (this.phase !== "lobby" || !by || !seat || seat === by || !!seat.bot) return;
    const how = await this.kicks.decide(by, by.name, by.id === this.hostId, seat, this.connectionOf(id));
    if (typeof how === "object") return client.send("billiard_error", how);
    if (this.phase !== "lobby" || !this.seat(id)) return;
    if (how === "kicked") this.banned.set(seat.playerId, by.playerId); // (a VIP Pro who chose to leave may come back)
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

  /** Support banned this player: out at once (mid-game his seat plays on as a bot). */
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

  private becomeBot(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.bot) return;
    seat.bot = "normal";
    seat.connected = true;
    if (this.phase === "playing" && this.turnSeat() === seat) this.botTurn(Math.max(0, this.turnStartsAt - Date.now()));
  }

  // ---- the game ----

  private turnSeat() {
    return this.phase === "playing" ? this.seats[this.game.turn] : undefined;
  }

  private newGame() {
    this.phase = "playing";
    this.game = new EightBall(this.lastLoser >= 0 ? this.lastLoser : Math.random() < 0.5 ? 0 : 1);
    this.balls = rack();
    this.shots = 0;
    this.ready.clear();
    this.updateListing();
    this.startTurn(0);
  }

  private startTurn(delayMs: number) {
    this.turnStartsAt = Date.now() + delayMs;
    this.turnEndsAt = this.turnStartsAt + this.turnSeconds * 1000;
    this.timer?.clear();
    this.botTimer?.clear();
    // (a bot shoots long before: this is for a player, or one who takes his seat back mid-turn)
    this.timer = this.clock.setTimeout(() => (this.timeOut(), this.sync()), delayMs + this.turnSeconds * 1000 + LATE_MS);
    if (this.turnSeat()?.bot) this.botTurn(delayMs);
  }

  /** The shot clock ran out: a foul, the other player has the cue ball anywhere. */
  private timeOut() {
    if (this.phase !== "playing") return;
    const who = this.game.turn;
    this.game.outOfTime();
    this.broadcast("billiard_fx", { type: "time", who });
    this.startTurn(0);
  }

  private botTurn(delayMs: number) {
    this.botTimer?.clear();
    this.botTimer = this.clock.setTimeout(() => {
      const seat = this.turnSeat();
      if (!seat?.bot) return;
      // ponytail: the bot's trials (~18 shots in the physics, ~80 ms) block the server's loop; a worker if rooms pile up
      const plan = botPlan(this.balls, this.game.copy(), BOT_SKILL[seat.bot]);
      const onEight = this.game.onEight(this.game.turn, this.onTable());
      this.shoot(plan.shot, this.game.ballInHand ? plan.place : null, onEight ? plan.pocket : null, true);
      this.sync();
    }, (delayMs + 700 + Math.random() * 700) * BilliardRoom.botSpeed);
  }

  private onTable() {
    return new Set(this.balls.filter((b) => b.pottedIn === null && b.n !== 0).map((b) => b.n));
  }

  private positions() {
    return this.balls.filter((b) => b.pottedIn === null).map((b) => [b.n, b.x, b.y]);
  }

  /** A player's shot: his turn, after the last shot is over on screen, before his clock runs out; a sound shot. */
  private handleShot(id: string, m: Record<string, unknown>) {
    const seat = this.turnSeat();
    if (!seat || seat.id !== id || seat.bot) return "not_your_turn";
    const now = Date.now();
    if (now < this.turnStartsAt - 500 || now > this.turnEndsAt + LATE_MS) return "too_late";
    const shot: Shot = { dx: num(m.dx), dy: num(m.dy), speed: num(m.speed), side: num(m.side ?? 0), height: num(m.height ?? 0) };
    if (![shot.dx, shot.dy, shot.speed, shot.side, shot.height].every(Number.isFinite)) return "bad_shot";
    if (Math.abs(shot.dx * shot.dx + shot.dy * shot.dy - 1) > 1e-6 || shot.speed <= 0 || shot.speed > tune.maxSpeed) return "bad_shot";
    if (shot.side * shot.side + shot.height * shot.height > 1.0001) return "bad_shot";
    let place: [number, number] | null = null;
    if (this.game.ballInHand) {
      const p = Array.isArray(m.place) ? m.place : [];
      place = [num(p[0]), num(p[1])];
      if (!freeSpot(this.balls, place[0], place[1], this.game.kitchenOnly)) return "bad_place";
    }
    let called: number | null = null;
    if (this.game.onEight(this.game.turn, this.onTable())) {
      called = num(m.called);
      if (!Number.isInteger(called) || called < 0 || called > 5) return "call_pocket";
    }
    this.shoot(shot, place, called, false);
  }

  /** Plays a shot to its end and tells everyone; the next turn once it's over on screen. */
  private shoot(shot: Shot, place: [number, number] | null, called: number | null, bot: boolean) {
    const by = this.game.turn;
    const cue = this.balls[0];
    if (place) [cue.x, cue.y, cue.pottedIn] = [place[0], place[1], null];
    const start = this.positions();
    const before = this.onTable();
    const sim = new Sim(this.balls);
    sim.shoot(shot);
    const steps = sim.run();
    const outcome = this.game.play(sim.log, before, called);
    const end = this.positions();
    this.shots++;
    if (outcome.rerack) this.balls = rack();
    const showMs = (bot ? BOT_AIM_MS : STROKE_MS) + steps + SETTLE_MS;
    if (outcome.winner !== null) {
      this.lastLoser = 1 - outcome.winner;
      this.phase = "gameover";
      this.timer?.clear();
      this.botTimer?.clear();
      this.ready = new Set(this.seats.filter(added).map((s) => s.id));
      this.turnEndsAt = Date.now() + showMs + CLOSE_AFTER_GAME_MS;
      this.timer = this.clock.setTimeout(() => (this.afterGame(true), this.sync()), showMs + CLOSE_AFTER_GAME_MS);
    } else {
      this.startTurn(showMs);
    }
    this.broadcast("billiard_shot", {
      seq: this.shots, by, bot, start, steps, outcome, end, place, called,
      shot: [shot.dx, shot.dy, shot.speed, shot.side, shot.height],
      game: this.gameState(),
    });
  }

  /** The aim of the player whose turn it is, passed on as it moves (where he holds the cue ball, and whether his hand is on it). */
  private handleAim(client: Client, m: Record<string, unknown>) {
    const seat = this.turnSeat();
    if (!seat || seat.id !== this.idOf(client)) return;
    const aim = { dx: num(m.dx), dy: num(m.dy), power: num(m.power), x: num(m.x), y: num(m.y), hold: num(m.hold ?? 0) };
    if (!Object.values(aim).every(Number.isFinite)) return;
    this.broadcast("billiard_aim", aim, { except: client });
  }

  // ---- after a game (as at the domino table) ----

  private handlePlayAgain(id: string) {
    if (this.phase !== "gameover" || !this.seat(id) || this.seat(id)!.bot) return;
    this.ready.add(id);
    this.afterGame(false);
  }

  private afterGame(timeUp: boolean) {
    if (this.phase !== "gameover") return;
    const players = this.seats.filter((s) => !added(s));
    if (!timeUp && players.some((s) => !s.bot && !this.ready.has(s.id))) return;
    this.timer?.clear();
    const again = players.filter((s) => this.pressed(s));
    if (again.length === 0) {
      this.abandon.closing = true;
      return void this.disconnect().catch(() => {});
    }
    if (again.length === players.length) {
      gameStarted(this.roomName);
      return this.newGame();
    }
    for (const s of [...this.seats]) {
      if (added(s) || this.pressed(s)) continue;
      const client = this.connectionOf(s.id);
      this.removeSeat(s.id);
      client?.leave(4000);
    }
    this.ready.clear();
    this.lastLoser = -1;
    this.phase = "lobby";
    this.updateListing();
  }

  private pressed(s: Seat) {
    return !s.bot && this.ready.has(s.id);
  }

  // ---- sync ----

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private gameState() {
    const g = this.game;
    return {
      turn: g.turn, groups: g.groups, breakShot: g.breakShot, ballInHand: g.ballInHand, kitchenOnly: g.kitchenOnly, winner: g.winner,
      turnStartsAt: this.turnStartsAt, turnEndsAt: this.turnEndsAt, serverNow: Date.now(),
    };
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
      },
    });
  }

  private sync() {
    this.abandon.check(this.seats);
    if ((this.phase !== "lobby") !== this.listedStarted) this.updateListing();
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      turnSeconds: this.turnSeconds,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, bot: s.bot ?? "",
        cue: s.cue,
      })),
      shots: this.shots,
      balls: this.positions(),
      ready: [...this.ready],
      spectators: this.spectators.size,
      ...this.gameState(),
    };
    for (const client of this.clients) client.send("billiard", { ...table, me: this.idOf(client) });
  }
}
