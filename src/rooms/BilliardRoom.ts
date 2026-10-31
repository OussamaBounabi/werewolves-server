import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, recordTable, settings, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { botPlan, EightBall, freeSpot, RAILS, rack, Sim, tune, type Ball, type Shot } from "../billiard.js";
import { bracket, nextSlot, type Match } from "../guess.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSeat, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";
import { cupPlaces, StakeTable } from "./stake.js";

/**
 * 8-ball, as in the app (lib/billiard). The server plays every shot in its own copy of the app's physics
 * (src/billiard.ts: the same to the last bit) and is the table's truth: a player sends his shot, the server plays it,
 * applies the rules and sends the shot with where the balls ended; each app plays it on screen and lands on those same
 * places. While a player aims, his aim ("aim") and the pocket and cushions he names ("pick") are passed on as they move.
 *
 * Three ways to play, the host's choice in the waiting room:
 * - 1 vs 1 (a seat may be a bot the host seats, easy, normal or hard); each player's wins counted over the rematches.
 * - A cup of 4, 6 (two byes) or 8 (bots fill the seats the host gives them): each round's matches played at the same
 *   time, each at its own table with its own chat and voice; a match is 1, 3 or 5 games. Who is out watches any match
 *   he picks and talks with its players; the final, everyone at its table.
 * - Winner stays, 3 to 8 people (no bots): two drawn at random play, the loser goes to the back of the line, the next
 *   plays the winner; each win a star. After the host's time (15 to 60 min) the game being played ends it: most stars
 *   wins. Those waiting watch the table and talk with its players.
 * Options: the pocket called for every ball, not only the 8; the 8 banked off two cushions, then one, then straight.
 *
 * No schema: "billiard" (the room and the table each one is at) after every change; to those at a table,
 * "billiard_shot" for each shot, "billiard_aim" / "billiard_pick" for an aim, "billiard_fx" for a shot clock that ran
 * out. The chat, emojis and voice as at the other tables. Each player plays with his own cue ("cue").
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; chat: boolean; started: boolean; players: number; maxPlayers: number; spectators: number; stake: number };
type Mode = "duel" | "cup" | "king";
type Settings = {
  roomType?: string; turnSeconds?: number; mode?: string; cupSize?: number; bestOf?: number; minutes?: number; callAll?: boolean; eight?: string;
  stake?: number;
};
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
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a normal bot (winner stays: he's out)
  cue: string; // his cue (the app's assets/images/billiard/cues/<cue>.webp)
  wins: number; // games won here (1 vs 1: over the rematches; winner stays: his stars)
  out: boolean; // a cup: lost his match
  left?: boolean; // winner stays: gone (his stars still shown)
};
type Pick = { called: number | null; rails: number[] }; // the pocket and cushions named for the shot being aimed
type Phase = "lobby" | "bracket" | "playing" | "gameover";

/** One table: two players and their game; [match]: the cup's match played at it. */
class Table {
  game = new EightBall();
  balls: Ball[] = rack(); // the cue ball always first
  shots = 0;
  games = 0; // games started here
  startedAt = 0; // this game's break, for its minutes
  score = [0, 0]; // games won in this match (a cup), by side
  turnStartsAt = 0; // the last shot is over on screen: the player may shoot
  turnEndsAt = 0;
  nextAt = 0; // the next game's start, once one ended (a cup's match, winner stays)
  done = false; // its match is over: it stays to be seen until the next round
  pick: Pick = { called: null, rails: [] };
  timer: { clear(): void } | null = null;
  botTimer: { clear(): void } | null = null;
  constructor(public id: number, public players: string[], public match: number) {}

  stop() {
    this.timer?.clear();
    this.botTimer?.clear();
  }
}

const ROOM_TYPES = ["public", "friends", "private"];
const TURN_OPTIONS = [15, 30, 45, 60];
const CUP_SIZES = [4, 6, 8];
const BEST_OF = [1, 3, 5];
const KING_MINUTES = [15, 30, 45, 60];
const MAX_SEATS = 8;
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_SKILL: Record<BotLevel, number> = { easy: 0.2, normal: 0.5, hard: 0.85 }; // how little its aim wobbles
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
// The apps' animations, so the next turn starts once a shot is over on screen: a player's stroke; the bot's (the cue
// ball placed, the cue turned, drawn back, then the stroke); time to settle (pots, the message) and for slow phones.
const STROKE_MS = 70;
const BOT_AIM_MS = 2020;
const SETTLE_MS = 900;
const LATE_MS = 1000; // a shot may arrive this late after the clock ran out (the network)
const GAME_GAP_MS = 5000; // a cup's match, winner stays: the game's end shown, then the next game
const BRACKET_MS = 6000; // a cup: the draw, and the bracket between rounds
const RECONNECT_SECONDS = 60; // a dropped player gone over a minute is out, as if he had left
const CLOSE_AFTER_GAME_MS = 60_000;
const MAX_SPECTATORS = 20;
const CUES = ["default", "navy", "gold", "royal"];

const added = (s: Seat) => s.id.startsWith("bot-");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const pocket = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 5 ? (v as number) : null);

/** Cushions named for the 8: distinct, real ones, [max] at most; null if not. */
function railsOf(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const rails = v.filter((r) => Number.isInteger(r) && r >= 0 && r < RAILS);
  return rails.length === v.length && new Set(rails).size === rails.length ? rails : null;
}

export class BilliardRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this);
  static botSpeed = 1; // tests: bots think faster, and the pauses between games are shorter
  maxClients = MAX_SEATS + MAX_SPECTATORS; // the seats are counted in onAuth (the mode may change)

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private turnSeconds = 30;
  private mode: Mode = "duel";
  private cupSize = 8;
  private bestOf = 1;
  private minutes = 30;
  private callAll = false;
  private banks = false;
  private seats: Seat[] = [];
  private members = new Map<string, string>();
  private invited = new Set<string>();
  private banned = new Map<string, string>();
  private spectators = new Map<string, JoinOptions>();
  private admins = new Set<string>();
  private tableTalk!: TableTalk; // the chat and emojis (a cup's: each table its own)
  private returned = new Map<string, string>();
  private listedStarted = false;
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" };
  private kicks = new Kicks(this); // who may put whom out of the waiting room (a VIP Pro may choose to stay)
  private looks = new RoomLooks();
  private get look() {
    return this.looks.of(this.hostId);
  }

  private tables = new Map<number, Table>();
  private tableSeq = 0;
  private watching = new Map<string, number>(); // who isn't playing → the table he watches
  private matches: Match[] = []; // a cup's (src/guess.ts' bracket)
  private queue: string[] = []; // winner stays: who plays next, in turn
  private endsAt = 0; // winner stays: when the last game starts to be the last
  private champion = "";
  private lastLoser = -1; // 1 vs 1: he breaks the next game
  private ready = new Set<string>();
  private botSeq = 0;
  private timer: { clear(): void } | null = null; // the room's own (the cup's rounds, the end)
  private stake = new StakeTable("billiard", this); // playing for coins (0: free): 1 vs 1 and cups, not winner stays
  private voiceAt = new Map<string, string>(); // each connection's voice room, once it asked for the voice
  private chatAt = new Map<string, string>(); // each connection's chat, last told
  private voiceRooms = new Set<string>(); // every voice room this room opened, closed with it

  /** A chat room (so from its creation, for good): no voice, everyone writes in the text chat. */
  private chatOnly = false;
  private get voiceOn() {
    return voiceEnabled && !this.chatOnly;
  }

  onCreate(options: JoinOptions = {}) {
    this.chatOnly = (options as { chat?: unknown }).chat === true;
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
    on<{ table: number }>("watch", (c, m) => this.handleWatch(c, m.table));
    this.onMessage("aim", (client, m: Record<string, unknown>) => this.handleAim(client, m ?? {}));
    this.onMessage("pick", (client, m: Record<string, unknown>) => this.handlePick(client, m ?? {}));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.tableTalk = new TableTalk(this, (c) => this.seat(this.idOf(c)), (c) => this.idOf(c), (c) => this.chatOf(this.idOf(c)));
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
      if (this.seats.length >= this.capacity()) throw new ServerError(4409, "full");
      const stake = this.stake.joinError(account);
      if (stake) throw new ServerError(4402, stake);
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
    this.chatAt.set(client.sessionId, this.chatOf(this.idOf(client)));
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
      wins: 0,
      out: false,
    });
    if (!this.hostId) this.hostId = this.idOf(client);
  }

  private handleSit(client: Client) {
    const options = this.spectators.get(this.idOf(client));
    if (this.phase !== "lobby" || !options) return;
    if (this.seats.length >= this.capacity()) return "full";
    const stake = this.stake.joinError(client.auth?.account ?? null);
    if (stake) return stake;
    this.spectators.delete(this.idOf(client));
    this.addSeat(client, options);
    if (this.voiceOn) setVoiceRights(this.roomId, this.idOf(client), { talk: true, hear: true }).catch(() => {});
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
    const t = this.tableOf(seat.id);
    if (t && this.turnSeat(t)?.id === seat.id) t.botTimer?.clear(); // his turn: his to play, in the time left
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
    const voiceRoom = this.voiceAt.get(client.sessionId) ?? this.roomId;
    this.voiceAt.delete(client.sessionId);
    this.chatAt.delete(client.sessionId);
    if (this.admins.delete(client.sessionId)) {
      if (this.voiceOn) dropFromVoice(voiceRoom, client.sessionId).catch(() => {});
      return;
    }
    const id = this.idOf(client);
    this.returned.delete(client.sessionId);
    this.watching.delete(id);
    const uid = this.members.get(id);
    this.members.delete(id);
    if (uid) leaveRoom(uid, this.roomId);
    if (this.voiceOn) dropFromVoice(voiceRoom, id).catch(() => {});
    if (this.spectators.delete(id)) {
      this.updateListing();
      return this.sync();
    }
    if (this.abandon.closing) return;
    if (this.phase === "lobby") this.removeSeat(id);
    else if (this.mode === "king") this.kingLeave(id);
    else {
      this.stake.leave(this.seat(id)?.playerId ?? ""); // (his stake stays in the pot)
      this.becomeBot(id);
    }
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && !s.left && this.connectionOf(s.id))?.id ?? "";
    this.afterGame(false);
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.stake.refund(); // (closing mid-game: those still here get their stake back)
    this.timer?.clear();
    for (const t of this.tables.values()) t.stop();
    if (this.voiceOn) for (const room of [this.roomId, ...this.voiceRooms]) closeVoice(room).catch(() => {});
  }

  /** The voice room [id] belongs in: the room's own; in a cup's games, his table's. */
  private voiceOf(id: string) {
    const t = this.viewOf(id);
    if (this.mode !== "cup" || this.phase === "lobby" || !t) return this.roomId;
    const room = `${this.roomId}-t${t.id}`;
    this.voiceRooms.add(room);
    return room;
  }

  /** The chat [id] writes in and reads: the room's own; in a cup's games, his table's. */
  private chatOf(id: string) {
    const t = this.viewOf(id);
    return this.mode !== "cup" || this.phase === "lobby" || !t ? "" : `t${t.id}`;
  }

  private async handleVoiceJoin(client: Client) {
    if (!this.voiceOn) return client.send("voice", { enabled: false, chat: this.chatOnly });
    if (this.admins.has(client.sessionId)) { // the admin listens, unseen
      const room = this.voiceOf(client.sessionId);
      this.voiceAt.set(client.sessionId, room);
      return client.send("voice", { enabled: true, ...(await voiceToken(room, client.sessionId, "admin", { talk: false, hear: true }, false, true)) });
    }
    const id = this.idOf(client);
    const room = this.voiceOf(id);
    this.voiceAt.set(client.sessionId, room);
    const name = this.seat(id)?.name ?? client.auth?.account?.name ?? "spectator";
    // Players talk; of those watching, only VIP Pro.
    const talk = !!this.seat(id) || client.auth?.account?.vipPro === true;
    client.send("voice", { enabled: true, ...(await voiceToken(room, id, name, { talk, hear: true })) });
  }

  // ---- the waiting room ----

  /** The seats the mode has: 1 vs 1 two, a cup its size, winner stays eight. */
  private capacity() {
    return this.mode === "duel" ? 2 : this.mode === "cup" ? this.cupSize : MAX_SEATS;
  }

  private applySettings(s: Settings) {
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
    // (back to 1 vs 1 only with two seated at most; a cup at least as big as the seats; winner stays without bots)
    if (s.mode === "duel" && this.seats.length <= 2) this.mode = "duel";
    if (s.mode === "cup") {
      this.mode = "cup";
      if (this.cupSize < this.seats.length) this.cupSize = CUP_SIZES.find((n) => n >= this.seats.length) ?? MAX_SEATS;
    }
    if (s.mode === "king") {
      this.mode = "king";
      this.seats = this.seats.filter((x) => !x.bot);
    }
    const size = Number(s.cupSize);
    if (CUP_SIZES.includes(size) && size >= this.seats.length) this.cupSize = size;
    if (BEST_OF.includes(Number(s.bestOf))) this.bestOf = Number(s.bestOf);
    if (KING_MINUTES.includes(Number(s.minutes))) this.minutes = Number(s.minutes);
    if (typeof s.callAll === "boolean") this.callAll = s.callAll;
    if (s.eight === "direct" || s.eight === "banks") this.banks = s.eight === "banks";
    // A stake: 1 vs 1 and cups, never with bots; winner stays is free.
    if (s.stake !== undefined && !(Number(s.stake) > 0 && this.seats.some((x) => x.bot))) this.stake.set(s.stake);
    if (this.mode === "king") this.stake.set(0);
    this.updateListing();
  }

  private handleAddBot(client: Client, level: string) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || this.mode === "king") return;
    if (this.seats.length >= this.capacity()) return;
    if (settings().bots["billiard"] === false) return "bots_off"; // (the owner took this game's bots away)
    if (this.stake.amount) return "stake_bots";
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
      wins: 0,
      out: false,
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
    if (this.mode === "king" ? this.seats.length < 3 : this.seats.length < this.capacity()) return "not_enough_players";
    // Each puts his stake in the pot (a free table: at once); then the game, if nobody left meanwhile.
    this.stake.begin(
      this.seats.filter((s) => !s.bot),
      () => {
        if (this.phase !== "lobby" || this.seats.length < (this.mode === "king" ? 3 : this.capacity())) return false;
        this.begin();
        this.sync();
      },
      (why) => (client.send("billiard_error", why), this.sync()),
    );
  }

  /** The game starts: 1 vs 1 at one table, a cup's draw, or winner stays' queue. */
  private begin() {
    for (const s of this.seats) Object.assign(s, { wins: 0, out: false, left: false });
    this.closeTables();
    this.champion = "";
    this.lastLoser = -1;
    gameStarted(this.roomName);
    if (this.mode === "duel") {
      this.phase = "playing";
      this.startGame(this.openTable(this.seats.map((s) => s.id), -1), Math.random() < 0.5 ? 0 : 1);
    } else if (this.mode === "cup") {
      this.matches = bracket(this.seats.map((s) => s.id));
      this.phase = "bracket";
      this.later(BRACKET_MS * BilliardRoom.botSpeed, () => this.cupRound());
    } else {
      this.queue = this.seats.map((s) => s.id).sort(() => Math.random() - 0.5);
      this.endsAt = Date.now() + this.minutes * 60_000;
      this.phase = "playing";
      this.startGame(this.openTable(this.queue.splice(0, 2), -1), Math.random() < 0.5 ? 0 : 1);
    }
    this.updateListing();
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
    const t = this.tableOf(id);
    if (t && this.phase === "playing" && this.turnSeat(t) === seat) this.botTurn(t, Math.max(0, t.turnStartsAt - Date.now()));
  }

  /** Winner stays: who leaves is out (his stars stay on the list); at the table, his game is lost. */
  private kingLeave(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.left) return;
    seat.left = true;
    seat.connected = false;
    this.queue = this.queue.filter((q) => q !== id);
    const t = this.tableOf(id);
    if (t && t.game.winner === null && this.phase === "playing") {
      const w = 1 - t.players.indexOf(id);
      t.game.winner = w;
      t.stop();
      this.gameOver(t, w, 0);
    }
  }

  private later(ms: number, then: () => void) {
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms);
  }

  // ---- the tables ----

  private openTable(players: string[], match: number) {
    const t = new Table(++this.tableSeq, players, match);
    this.tables.set(t.id, t);
    return t;
  }

  private closeTables() {
    for (const t of this.tables.values()) t.stop();
    this.tables.clear();
    this.watching.clear();
  }

  /** The table where [id] plays a game now (its match not over). */
  private tableOf(id: string) {
    for (const t of this.tables.values()) if (!t.done && t.players.includes(id)) return t;
    return undefined;
  }

  /** The table [id] sees: his own, the one he picked to watch, his last, or the first. */
  private viewOf(id: string) {
    const own = this.tableOf(id);
    if (own) return own;
    const watched = this.tables.get(this.watching.get(id) ?? -1);
    if (watched) return watched;
    const tables = [...this.tables.values()];
    return tables.find((t) => t.players.includes(id)) ?? tables.find((t) => !t.done) ?? tables[0];
  }

  /** Someone not playing now picks a table to watch (a cup: any match being played). */
  private handleWatch(client: Client, table: number) {
    const id = this.idOf(client);
    if (this.tableOf(id) || !this.tables.has(table)) return;
    this.watching.set(id, table);
  }

  /** To everyone who sees [t] (but [except]). */
  private toTable(t: Table, type: string, msg: unknown, except?: Client) {
    for (const c of this.clients) if (c !== except && this.viewOf(this.idOf(c)) === t) c.send(type, msg);
  }

  /** A new game at [t], [breaker] (0 or 1: its players' order) breaking. */
  private startGame(t: Table, breaker: number) {
    t.startedAt = Date.now();
    t.game = new EightBall(breaker, { callAll: this.callAll, banks: this.banks });
    t.balls = rack();
    t.shots = 0;
    t.games++;
    t.nextAt = 0;
    this.startTurn(t, 0);
  }

  /** A cup's next round: its matches, each at its own table, all at once. */
  private cupRound() {
    for (const [i, t] of this.tables) if (t.done) this.tables.delete(i);
    this.phase = "playing";
    for (const [i, m] of this.matches.entries()) {
      if (m.winner || !m.a || !m.b) continue;
      this.startGame(this.openTable([m.a, m.b], i), Math.random() < 0.5 ? 0 : 1);
    }
    // The final: everyone at its table.
    const live = [...this.tables.values()];
    if (live.length === 1) for (const s of this.seats) this.watching.set(s.id, live[0].id);
  }

  private turnSeat(t: Table) {
    return this.phase === "playing" && !t.done && t.game.winner === null ? this.seat(t.players[t.game.turn]) : undefined;
  }

  /** The table where it's [id]'s turn. */
  private turnTable(id: string) {
    const t = this.tableOf(id);
    return t && this.turnSeat(t)?.id === id ? t : undefined;
  }

  private startTurn(t: Table, delayMs: number) {
    t.turnStartsAt = Date.now() + delayMs;
    t.turnEndsAt = t.turnStartsAt + this.turnSeconds * 1000;
    t.pick = { called: null, rails: [] };
    t.stop();
    // (a bot shoots long before: this is for a player, or one who takes his seat back mid-turn)
    t.timer = this.clock.setTimeout(() => (this.timeOut(t), this.sync()), delayMs + this.turnSeconds * 1000 + LATE_MS);
    if (this.turnSeat(t)?.bot) this.botTurn(t, delayMs);
  }

  /** The shot clock ran out: a foul, the other player has the cue ball anywhere. */
  private timeOut(t: Table) {
    if (!this.turnSeat(t)) return;
    const who = t.game.turn;
    t.game.outOfTime(this.onTable(t));
    this.toTable(t, "billiard_fx", { type: "time", who, table: t.id });
    this.startTurn(t, 0);
  }

  private botTurn(t: Table, delayMs: number) {
    t.botTimer?.clear();
    t.botTimer = this.clock.setTimeout(() => {
      const seat = this.turnSeat(t);
      if (!seat?.bot) return;
      // ponytail: the bot's trials (~18 shots in the physics, ~80 ms) block the server's loop; a worker if rooms pile up
      const plan = botPlan(t.balls, t.game.copy(), BOT_SKILL[seat.bot]);
      const call = t.game.mustCall(t.game.turn, this.onTable(t));
      const onEight = t.game.onEight(t.game.turn, this.onTable(t));
      this.shoot(t, plan.shot, t.game.ballInHand ? plan.place : null, call ? plan.pocket ?? 0 : null, onEight ? plan.rails : [], true);
      this.sync();
    }, (delayMs + 700 + Math.random() * 700) * BilliardRoom.botSpeed);
  }

  private onTable(t: Table) {
    return new Set(t.balls.filter((b) => b.pottedIn === null && b.n !== 0).map((b) => b.n));
  }

  private positions(t: Table | undefined) {
    return (t?.balls ?? rack()).filter((b) => b.pottedIn === null).map((b) => [b.n, b.x, b.y]);
  }

  /** A player's shot: his turn, after the last shot is over on screen, before his clock runs out; a sound shot. */
  private handleShot(id: string, m: Record<string, unknown>) {
    const t = this.turnTable(id);
    if (!t || this.seat(id)?.bot) return "not_your_turn";
    const now = Date.now();
    if (now < t.turnStartsAt - 500 || now > t.turnEndsAt + LATE_MS) return "too_late";
    const shot: Shot = { dx: num(m.dx), dy: num(m.dy), speed: num(m.speed), side: num(m.side ?? 0), height: num(m.height ?? 0) };
    if (![shot.dx, shot.dy, shot.speed, shot.side, shot.height].every(Number.isFinite)) return "bad_shot";
    if (Math.abs(shot.dx * shot.dx + shot.dy * shot.dy - 1) > 1e-6 || shot.speed <= 0 || shot.speed > tune.maxSpeed) return "bad_shot";
    if (shot.side * shot.side + shot.height * shot.height > 1.0001) return "bad_shot";
    let place: [number, number] | null = null;
    if (t.game.ballInHand) {
      const p = Array.isArray(m.place) ? m.place : [];
      place = [num(p[0]), num(p[1])];
      if (!freeSpot(t.balls, place[0], place[1], t.game.kitchenOnly)) return "bad_place";
    }
    const me = t.game.turn, table = this.onTable(t);
    let called: number | null = null;
    if (t.game.mustCall(me, table)) {
      called = pocket(m.called);
      if (called === null) return "call_pocket";
    }
    let rails: number[] = [];
    const need = t.game.onEight(me, table) ? t.game.banks[me] : 0;
    if (need > 0) {
      const named = railsOf(m.rails, need);
      if (!named || named.length !== need) return "call_rails";
      rails = named;
    }
    this.shoot(t, shot, place, called, rails, false);
  }

  /** Plays a shot to its end and tells its table; the next turn once it's over on screen. */
  private shoot(t: Table, shot: Shot, place: [number, number] | null, called: number | null, rails: number[], bot: boolean) {
    const by = t.game.turn;
    const cue = t.balls[0];
    if (place) [cue.x, cue.y, cue.pottedIn] = [place[0], place[1], null];
    const start = this.positions(t);
    const before = this.onTable(t);
    const sim = new Sim(t.balls);
    sim.shoot(shot);
    const steps = sim.run();
    const outcome = t.game.play(sim.log, before, called, rails);
    const end = this.positions(t);
    t.shots++;
    if (outcome.rerack) t.balls = rack();
    const showMs = (bot ? BOT_AIM_MS : STROKE_MS) + steps + SETTLE_MS;
    if (outcome.winner !== null) this.gameOver(t, outcome.winner, showMs);
    else this.startTurn(t, showMs);
    this.toTable(t, "billiard_shot", {
      table: t.id, seq: t.shots, by, bot, start, steps, outcome, end, place, called, rails,
      shot: [shot.dx, shot.dy, shot.speed, shot.side, shot.height],
      game: this.gameState(t),
    });
  }

  /** A game at [t] is over, [w] (its side) won; [showMs]: its last shot on screen. What comes next is the mode's. */
  private gameOver(t: Table, w: number, showMs: number) {
    t.stop();
    const winner = this.seat(t.players[w]), loser = t.players[1 - w];
    if (winner) winner.wins++;
    // Every game counts for its two players, whatever the mode.
    const players = t.players.map((id) => this.seat(id)).filter((x) => x !== undefined);
    recordTable("billiard", players, winner ? [winner.uid] : [], t.startedAt);
    if (this.mode === "duel") {
      this.stake.settle(winner ? [winner.playerId] : []);
      this.lastLoser = 1 - w;
      this.phase = "gameover";
      this.ready = new Set(this.seats.filter(added).map((s) => s.id));
      t.turnEndsAt = Date.now() + showMs + CLOSE_AFTER_GAME_MS;
      this.later(showMs + CLOSE_AFTER_GAME_MS, () => this.afterGame(true));
      return;
    }
    t.nextAt = Date.now() + showMs + GAME_GAP_MS;
    const next = (then: () => void) => {
      t.timer = this.clock.setTimeout(() => (then(), this.sync()), showMs + GAME_GAP_MS * BilliardRoom.botSpeed);
    };
    if (this.mode === "king") {
      if (!this.seat(loser)?.left) this.queue.push(loser);
      this.queue = this.queue.filter((q) => !this.seat(q)?.left);
      if (Date.now() >= this.endsAt || this.queue.length === 0) {
        t.nextAt = 0;
        return this.end(showMs);
      }
      // the winner stays (gone meanwhile: the next in line takes his place); the next in line breaks
      return next(() => {
        this.queue = this.queue.filter((q) => !this.seat(q)?.left);
        const stays = this.seat(t.players[w])?.left ? this.queue.shift() : t.players[w];
        const challenger = this.queue.shift();
        if (!stays || !challenger) return this.end(0);
        t.players = [stays, challenger];
        this.startGame(t, 1);
      });
    }
    // A cup: the match goes on (the loser breaks), or its winner goes through.
    const m = this.matches[t.match];
    m.rounds.push(w);
    t.score[w]++;
    if (t.score[w] < Math.ceil(this.bestOf / 2)) return next(() => this.startGame(t, 1 - w));
    m.winner = t.players[w];
    t.done = true;
    t.nextAt = 0;
    const lost = this.seat(loser);
    if (lost) lost.out = true;
    const slot = nextSlot(this.matches.length + 1, t.match);
    if (slot) this.matches[slot.match][slot.side] = m.winner;
    if ([...this.tables.values()].some((x) => !x.done)) return; // the round goes on at the other tables
    if (!slot) {
      this.champion = m.winner;
      this.stake.settleCup(cupPlaces(this.matches).map((place) => place.map((id) => this.seat(id)?.playerId ?? "")));
      return this.end(showMs);
    }
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => {
      this.phase = "bracket"; // the bracket a moment, then the next round
      this.sync();
      this.later(BRACKET_MS * BilliardRoom.botSpeed, () => this.cupRound());
    }, showMs + GAME_GAP_MS * BilliardRoom.botSpeed);
  }

  /** A cup or winner stays is over: the champion (winner stays: most stars) and "play again", for a minute. */
  private end(showMs: number) {
    if (this.mode === "king") {
      const best = Math.max(...this.seats.map((s) => s.wins));
      this.champion = this.seats.find((s) => s.wins === best)?.id ?? "";
    }
    for (const t of this.tables.values()) t.stop();
    this.queue = [];
    this.phase = "gameover";
    this.ready = new Set(this.seats.filter(added).map((s) => s.id));
    this.later(showMs + CLOSE_AFTER_GAME_MS, () => this.afterGame(true));
  }

  /** The aim of the player whose turn it is, passed on as it moves (where he holds the cue ball, and whether his hand is on it). */
  private handleAim(client: Client, m: Record<string, unknown>) {
    const t = this.turnTable(this.idOf(client));
    if (!t) return;
    const aim = { dx: num(m.dx), dy: num(m.dy), power: num(m.power), x: num(m.x), y: num(m.y), hold: num(m.hold ?? 0) };
    if (!Object.values(aim).every(Number.isFinite)) return;
    this.toTable(t, "billiard_aim", { ...aim, table: t.id }, client);
  }

  /** The pocket (and on the 8 the cushions) he names, passed on the moment he picks them. */
  private handlePick(client: Client, m: Record<string, unknown>) {
    const t = this.turnTable(this.idOf(client));
    if (!t) return;
    const called = m.called === null || m.called === undefined ? null : pocket(m.called);
    const rails = railsOf(m.rails ?? [], RAILS);
    if ((called === null && m.called !== null && m.called !== undefined) || !rails) return;
    t.pick = { called, rails };
    this.toTable(t, "billiard_pick", { table: t.id, ...t.pick }, client);
  }

  // ---- after a game ----

  private handlePlayAgain(id: string) {
    if (this.phase !== "gameover" || !this.seat(id) || this.seat(id)!.bot) return;
    this.ready.add(id);
    this.afterGame(false);
  }

  /** Once everyone chose (or the minute is up): 1 vs 1 plays again if both want it; else the waiting room, with those
   * who pressed "play again". Nobody: the room closes. */
  private afterGame(timeUp: boolean) {
    if (this.phase !== "gameover") return;
    const players = this.seats.filter((s) => !added(s) && !s.left);
    if (!timeUp && players.some((s) => !s.bot && !this.ready.has(s.id))) return;
    this.timer?.clear();
    const again = players.filter((s) => this.pressed(s));
    if (again.length === 0) {
      this.abandon.closing = true;
      return void this.disconnect().catch(() => {});
    }
    if (again.length === players.length && this.mode === "duel") {
      // A new stake each game: one can't pay, the waiting room.
      return this.stake.begin(
        players.filter((s) => !s.bot),
        () => {
          if (this.phase !== "gameover") return false;
          gameStarted(this.roomName);
          this.phase = "playing";
          const t = [...this.tables.values()][0];
          this.ready.clear();
          this.startGame(t, this.lastLoser >= 0 ? this.lastLoser : 0);
          this.sync();
        },
        (why) => (this.broadcast("billiard_error", why), this.backToLobby(), this.sync()),
      );
    }
    this.backToLobby();
  }

  /** The waiting room again, with those who pressed "play again" (and the host's bots). */
  private backToLobby() {
    for (const s of [...this.seats]) {
      if (added(s) || this.pressed(s)) continue;
      const client = this.connectionOf(s.id);
      this.removeSeat(s.id);
      client?.leave(4000);
    }
    this.ready.clear();
    this.lastLoser = -1;
    this.closeTables();
    this.matches = [];
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

  private gameState(t: Table | undefined) {
    const g = t?.game ?? new EightBall(0, { callAll: this.callAll, banks: this.banks });
    return {
      turn: g.turn, groups: g.groups, breakShot: g.breakShot, ballInHand: g.ballInHand, kitchenOnly: g.kitchenOnly, winner: g.winner,
      callAll: g.callAll, banks: g.banks,
      turnStartsAt: t?.turnStartsAt ?? 0, turnEndsAt: t?.turnEndsAt ?? 0, serverNow: Date.now(),
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
      chat: this.chatOnly,
        started: this.phase !== "lobby",
        players: this.seats.length,
        maxPlayers: this.capacity(),
        spectators: this.spectators.size,
        stake: this.stake.amount,
      },
    });
  }

  private sync() {
    this.abandon.check(this.seats);
    if ((this.phase !== "lobby") !== this.listedStarted) this.updateListing();
    const face = (s: Seat) => ({
      id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, bot: s.bot ?? "",
      cue: s.cue, wins: s.wins, out: s.out || !!s.left,
    });
    const players = this.seats.map(face);
    const room = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      chat: this.chatOnly,
      turnSeconds: this.turnSeconds,
      mode: this.mode,
      cupSize: this.cupSize,
      bestOf: this.bestOf,
      minutes: this.minutes,
      callAll: this.callAll,
      eight: this.banks ? "banks" : "direct",
      players,
      tables: [...this.tables.values()].filter((t) => !t.done).map((t) => ({ id: t.id, players: t.players, match: t.match })),
      matches: this.matches,
      queue: this.queue,
      endsAt: this.endsAt,
      champion: this.champion,
      ready: [...this.ready],
      spectators: this.spectators.size,
      stake: this.stake.amount,
      stakeLast: this.stake.last, // the last game's payouts
    };
    for (const client of this.clients) {
      const id = this.idOf(client);
      const t = this.phase === "lobby" ? undefined : this.viewOf(id);
      client.send("billiard", {
        ...room,
        me: id,
        // (the table this one sees: its two players as "seats", in the rules' order; the waiting room: everyone)
        seats: t ? t.players.map((p) => this.seat(p)).filter((s) => !!s).map(face) : players,
        table: t?.id ?? -1,
        match: t?.match ?? -1,
        games: t?.games ?? 0,
        score: t?.score ?? [0, 0],
        nextAt: t?.nextAt ?? 0,
        done: t?.done ?? false,
        pick: t?.pick ?? { called: null, rails: [] },
        shots: t?.shots ?? 0,
        balls: this.positions(t),
        ...this.gameState(t),
      });
      // gone to another table: its chat, and (once he has the voice) its voice
      const chat = this.chatOf(id);
      if (this.chatAt.get(client.sessionId) !== chat) {
        this.chatAt.set(client.sessionId, chat);
        this.tableTalk.history(client);
      }
      const voice = this.voiceAt.get(client.sessionId);
      if (voice !== undefined && voice !== this.voiceOf(this.admins.has(client.sessionId) ? client.sessionId : id)) {
        void this.handleVoiceJoin(client);
      }
    }
  }
}
