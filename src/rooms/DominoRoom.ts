import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, recordTable, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import {
  botMove, ends, misdeal, opener, pips, place, playable, shuffledTiles, sidesFor, type BotLevel, type Line, type Misdeal,
} from "../domino.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSeat, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";

/**
 * Dominoes, 2–4 players (bots included), double six: 7 tiles each; with fewer than 4 players the rest
 * is the pile (on the empty chair). A player with no tile that fits draws until one does — or passes
 * once the pile is empty. Round 1 starts with the highest double (6-6), then the last winner starts.
 * Whoever plays his last tile scores every dot left in the opponents' hands; when nobody can play,
 * the fewest dots wins (a tie: nobody scores). 2 vs 2: partners face to face, one score per team; blocked, the
 * single lightest hand of the four wins for its team. Once a team has half the target, its round winner chooses who
 * opens the next round: he or his partner (his turn's time; nothing chosen, he opens).
 * The first to the room's target wins the match. Then each player may press "play again": everyone did, the same table
 * plays a new match from 0; one of them left, or a minute went by, whoever pressed goes back to the waiting room.
 *
 * No schema: each player gets his own "domino" message (the table, plus his tiles) after every change,
 * and "domino_fx" for what the apps animate (the deal, draws, plays, passes).
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type Settings = { roomType?: string; maxPlayers?: number; turnSeconds?: number; target?: number; teams?: boolean };
type JoinOptions = Settings & { admin?: boolean; name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number; // the animated frame he wears, 0 none
  vip?: string; // "vip" | "pro": his badge by his name
  connected: boolean;
  score: number;
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a normal bot
};
type Phase = "lobby" | "playing" | "round_end" | "gameover";
type RoundResult = {
  round: number;
  winner: string; // "" when nobody scores (a blocked tie)
  blocked: boolean;
  points: number;
  dots: Record<string, number>; // each player's dots left
};

const MAX_SEATS = 4;
const ROOM_TYPES = ["public", "friends", "private"];
const TURN_OPTIONS = [15, 30, 45, 60];
const TARGET_OPTIONS = [100, 150, 200, 250];
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
const HAND = 7;
const DEAL_MS = 3_000; // the apps' shuffle and deal, before the first turn
const PASS_MS = 1_200; // nothing fits and the pile is empty: shown, then the turn moves on
const READY_WAIT_MS = 30_000; // between rounds: who hasn't pressed "ready" by then is ready anyway
const NEXT_ROUND_MS = 5_000;
const REDEAL_MS = 4_500; // a hand dealt again: the reason shown, then the new deal
const RECONNECT_SECONDS = 60; // a dropped player gone over a minute is out, as if he had left
const CLOSE_AFTER_GAME_MS = 60_000; // after a match: a minute to press "play again" (nobody did: the room closes)

const MAX_SPECTATORS = 20;

/** A bot the host put at the table (not a player's seat a bot plays on since he left). */
const added = (s: Seat) => s.id.startsWith("bot-");

export class DominoRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this); // nobody left to play: the room closes by itself
  static botSpeed = 1; // tests: bots think faster
  static shuffle = shuffledTiles; // tests: a deal of their choice
  maxClients = MAX_SEATS + MAX_SPECTATORS; // the seats are counted in onAuth

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private maxPlayers = 4;
  private turnSeconds = 30;
  private target = 150;
  private startedAt = 0; // the match's first deal, for its minutes
  private teams = false; // 2 vs 2: seats 0 & 2 against 1 & 3 (partners face to face)
  private teamScores = [0, 0];
  private seats: Seat[] = []; // seat order = turn order
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private banned = new Map<string, string>(); // a kicked player's id → who kicked him (the host then)
  private spectators = new Map<string, JoinOptions>(); // sessionId → how he came: watching a game, without a seat
  private tableTalk!: TableTalk; // the table's chat and emojis
  private admins = new Set<string>(); // the admin app watching, unseen (its God Eye: every hand)
  private returned = new Map<string, string>(); // a returning player's new connection → the seat he had
  private listedStarted = false; // what the room list was last told
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" }; // …and whose face it shows
  private kicks = new Kicks(this); // who may put whom out of the waiting room (a VIP Pro may choose to stay)
  private looks = new RoomLooks(); // a VIP Pro host's name and style for his room in the lists (kept on his account)
  private get look() {
    return this.looks.of(this.hostId);
  }
  private hands = new Map<string, number[]>();
  private pile: number[] = [];
  private line: Line = { first: null, left: [], right: [] };
  private forced: number | null = null; // the tile the round must start with (round 1: the highest double)
  private passes = 0; // passes in a row: everyone passed = blocked
  private lacks = new Map<string, Set<number>>(); // numbers each player showed he has none of (bots)
  private round = 0;
  private lastWinner = "";
  private turn = "";
  private choosing = ""; // 2 vs 2, a team at half the target: its round winner choosing who opens (he or his partner)
  private dealEndsAt = 0; // the deal's animation is over then
  private turnEndsAt = 0;
  private history: RoundResult[] = [];
  private ready = new Set<string>();
  private nextRoundAt = 0;
  private redeal: Misdeal | null = null; // the hand the tiles are being dealt again for (shown to everyone)
  private botSeq = 0;
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("domino_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && this.idOf(c) === this.hostId) this.applySettings(m);
    });
    on<{ level: string }>("add_bot", (c, m) => this.handleAddBot(c, m.level));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on<{ id: string }>("partner", (c, m) => this.handlePartner(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on("sit", (c) => this.handleSit(c));
    on<{ tile: number; side?: "left" | "right" }>("play", (c, m) => this.handlePlay(this.idOf(c), Number(m.tile), m.side));
    on("draw", (c) => this.handleDraw(this.idOf(c)));
    on<{ partner?: boolean }>("opener", (c, m) => this.handleOpener(this.idOf(c), m.partner === true));
    on("ready", (c) => this.handleReady(this.idOf(c)));
    on("play_again", (c) => this.handlePlayAgain(this.idOf(c)));
    on<{ id: string }>("kick", (c, m) => void this.handleKick(c, m.id));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.onMessage("room_look", (client, msg) => this.handleLook(client, msg));
    this.tableTalk = new TableTalk(this, (c) => this.seat(this.idOf(c)), (c) => this.idOf(c));
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (!this.seat(this.idOf(client)) || typeof msg?.uid !== "string") return;
      this.invited.add(msg.uid);
      if (this.idOf(client) === this.hostId) this.banned.delete(msg.uid); // the host takes his kick back
    });
    this.updateListing();
  }

  // ---- joining (as at the rummy table) ----

  async onAuth(_client: Client, options: JoinOptions = {}): Promise<{ account: Account | null; admin?: boolean }> {
    if (options.admin) { // the admin app: any room, unseen
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
    // Kicked by the host: kept out while he is the host.
    const kicker = this.banned.get(account?.uid ?? String(options.playerId ?? ""));
    if (kicker && this.seats.some((s) => s.playerId === kicker)) throw new ServerError(4403, "banned");
    // He left this game: back to the seat he had, whichever door he comes through.
    if (this.seatLeftBy(account?.uid ?? String(options.playerId ?? ""))) return { account };
    if (options.spectator) {
      if (this.phase === "lobby") throw new ServerError(4409, "lobby"); // nothing to watch yet: join it instead
      if (this.spectators.size >= MAX_SPECTATORS) throw new ServerError(4409, "full");
    } else {
      if (this.phase !== "lobby") throw new ServerError(4409, "started");
      if (this.seats.length >= this.maxPlayers) throw new ServerError(4409, "full");
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
    if (back) this.returned.set(client.sessionId, back.id); // (first: everything below files him under his seat's id)
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
      avatar: account?.avatar ?? randomAvatar(), // no account (a test client): a character at random
      frame: account?.frame ?? randomFrame(),
      vip: vipLevel(account),
      connected: true,
      score: 0,
      bot: null,
    });
    if (!this.hostId) this.hostId = this.idOf(client);
  }

  /** Back in the waiting room, a spectator takes a seat. */
  private handleSit(client: Client) {
    const options = this.spectators.get(this.idOf(client));
    if (this.phase !== "lobby" || !options) return;
    if (this.seats.length >= this.maxPlayers) return "full";
    this.spectators.delete(this.idOf(client));
    this.addSeat(client, options);
    if (voiceEnabled) setVoiceRights(this.roomId, this.idOf(client), { talk: true, hear: true }).catch(() => {});
    this.updateListing();
  }

  /** His seat's id: his connection's, or the seat he came back to. */
  private idOf(client: Client) {
    return this.returned.get(client.sessionId) ?? client.sessionId;
  }

  /** The connection of whoever holds this seat. */
  private connectionOf(id: string) {
    for (const [session, seat] of this.returned) if (seat === id) return this.clients.getById(session);
    return this.clients.getById(id);
  }

  /** During a game: the seat this player left. He comes back to it. */
  private seatLeftBy(playerId: string) {
    if (this.phase === "lobby" || !playerId) return undefined;
    return this.seats.find((s) => s.playerId === playerId && !!s.bot);
  }

  /** Back in his seat, under the id it always had: everything about the game knows him by it. */
  private retakeSeat(seat: Seat) {
    seat.bot = null;
    seat.connected = true;
    if (this.turn === seat.id) this.botTimer?.clear(); // his turn: his to play, in the time left
  }

  onDrop(client: Client) {
    if (this.admins.has(client.sessionId)) return holdSpectator(this, client);
    if (this.spectators.has(this.idOf(client))) return holdSpectator(this, client);
    const seat = this.seat(this.idOf(client));
    if (seat) seat.connected = false;
    holdSeat(this, client, RECONNECT_SECONDS);
    this.sync();
  }

  onReconnect(client: Client) {
    const seat = this.seat(this.idOf(client));
    // Away when the others went back to the waiting room without him: his seat went with the match.
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
    if (this.abandon.closing) return; // the room is closing: nobody takes his seat, nothing more is played
    if (this.phase === "lobby") this.removeSeat(id);
    else this.becomeBot(id); // (after a match too: he won't play the next one)
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && this.connectionOf(s.id))?.id ?? "";
    this.afterGame(false); // (he was the one the others waited for)
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
    const n = Math.floor(Number(s.maxPlayers));
    if (n >= 2 && n <= MAX_SEATS) this.maxPlayers = Math.max(n, this.seats.length);
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
    if (TARGET_OPTIONS.includes(Number(s.target))) this.target = Number(s.target);
    if (typeof s.teams === "boolean") this.teams = s.teams && this.seats.length <= 4;
    if (this.teams) this.maxPlayers = 4;
    this.updateListing();
  }

  private handleAddBot(client: Client, level: string) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || this.seats.length >= this.maxPlayers) return;
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
      score: 0,
      bot: BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : "normal",
    });
    this.updateListing();
  }

  private handleRemoveBot(client: Client, id: string) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || !this.seat(id)?.bot) return;
    this.removeSeat(id);
    this.updateListing();
  }

  /** 2 vs 2: the host picks his partner; seats become host, opponent, partner, opponent. */
  private handlePartner(client: Client, partnerId: string) {
    const host = this.idOf(client);
    if (this.phase !== "lobby" || host !== this.hostId || !this.teams || host === partnerId) return;
    const partner = this.seat(partnerId);
    if (!partner) return;
    const others = this.seats.filter((x) => x.id !== host && x.id !== partnerId);
    this.seats = [this.seat(host)!, others[0], partner, others[1]].filter((x) => x !== undefined);
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId) return;
    if (this.seats.length < 2) return "not_enough_players";
    if (this.teams && this.seats.length !== 4) return "teams_need_four";
    this.startedAt = Date.now();
    this.deal();
  }

  /**
   * Out of the waiting room, and kept out while whoever put him out is here (the host's invite lets him in): by the
   * host, or by a VIP Pro who isn't (3 a month); a VIP Pro only by a VIP Pro.
   */
  private async handleKick(client: Client, id: string) {
    const seat = this.seat(id), by = this.seat(this.idOf(client));
    if (this.phase !== "lobby" || !by || !seat || seat === by || !!seat.bot) return;
    const how = await this.kicks.decide(by, by.name, by.id === this.hostId, seat, this.connectionOf(id));
    if (typeof how === "object") return client.send("domino_error", how);
    if (this.phase !== "lobby" || !this.seat(id)) return; // (the game began, or he left, meanwhile)
    if (how === "kicked") this.banned.set(seat.playerId, by.playerId); // (a VIP Pro who chose to leave may come back)
    const kicked = this.connectionOf(id);
    if (how === "kicked") kicked?.send("kicked");
    this.removeSeat(id);
    this.updateListing();
    kicked?.leave(4000);
    this.sync();
  }

  /** A VIP Pro host names his room and picks its style, for the lists. */
  private handleLook(client: Client, msg: unknown) {
    if (this.idOf(client) !== this.hostId || !this.looks.set(this.hostId, msg)) return;
    this.updateListing();
  }

  /** Support banned this player: out at once, the table told "removed by support"; mid-game his seat plays on as usual. */
  removeBanned(uid: string) {
    for (const [id, member] of this.members) {
      if (member !== uid) continue;
      const seat = this.seat(id);
      if (seat) this.broadcast("removed", { name: seat.name });
      this.connectionOf(id)?.leave(4000); // (4000: a leave, not a drop — no seat held for him)
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
    if (this.phase === "round_end") this.handleReady(id);
    if (this.turn === id && this.phase === "playing") this.startTurn(id);
  }

  private teamOf(id: string) {
    return this.seats.findIndex((x) => x.id === id) % 2;
  }

  private sameSide(a: string, b: string) {
    return a === b || (this.teams && this.teamOf(a) === this.teamOf(b));
  }

  // ---- the round ----

  /** [again]: the last deal had a hand with six tiles of one number or five doubles: the same round, dealt again. */
  private deal(again = false) {
    if (!again) this.round++;
    this.phase = "playing";
    const tiles = DominoRoom.shuffle();
    for (const s of this.seats) this.hands.set(s.id, []);
    for (let i = 0; i < HAND; i++) for (const s of this.seats) this.hands.get(s.id)!.push(tiles.pop()!);
    this.pile = tiles; // 4 players: empty
    this.line = { first: null, left: [], right: [] };
    this.passes = 0;
    this.lacks.clear();
    this.ready.clear();
    this.nextRoundAt = 0;
    this.redeal = null;
    this.choosing = "";
    this.broadcast("domino_fx", { type: "deal", order: this.seats.map((s) => s.id), pile: this.pile.length });
    // Such a hand: everyone is told why (his hand shown), then the tiles are shuffled and dealt again.
    const bad = misdeal(this.hands);
    if (bad) {
      this.redeal = bad;
      this.turn = "";
      this.forced = null;
      this.timer?.clear();
      this.botTimer?.clear();
      this.nextRoundAt = this.turnEndsAt = Date.now() + DEAL_MS + REDEAL_MS;
      this.timer = this.clock.setTimeout(() => (this.deal(true), this.sync()), DEAL_MS + REDEAL_MS);
      return;
    }
    // Round 1, after a tie, or dealt again: the highest double starts (6-6 first), with it. Then the last winner,
    // any tile.
    const winner = again ? undefined : this.seat(this.lastWinner);
    let first: string;
    if (winner && this.teams && this.seats.length === 4 && this.teamScores[this.teamOf(winner.id)] * 2 >= this.target) {
      // His team has half the target: he chooses who opens, he or his partner.
      this.forced = null;
      this.turn = "";
      this.choosing = winner.id;
      this.dealEndsAt = Date.now() + DEAL_MS;
      this.turnEndsAt = this.dealEndsAt + this.turnSeconds * 1000;
      this.timer?.clear();
      this.botTimer?.clear();
      this.timer = this.clock.setTimeout(() => (this.handleOpener(winner.id, false), this.sync()), DEAL_MS + this.turnSeconds * 1000);
      // ponytail: a bot opens himself; choose by the hands if players ask for a smarter partner
      if (winner.bot) this.botTimer = this.clock.setTimeout(() => (this.handleOpener(winner.id, false), this.sync()), DEAL_MS + 800 / DominoRoom.botSpeed);
      return;
    }
    if (winner) {
      first = winner.id;
      this.forced = null;
    } else {
      const open = opener(this.hands)!;
      first = open.id;
      this.forced = open.tile;
    }
    this.startTurn(first, DEAL_MS);
  }

  /** The round winner's choice: he opens, or his partner does (any tile, as a winner opens). */
  private handleOpener(id: string, partner: boolean) {
    if (this.phase !== "playing" || this.choosing !== id) return;
    this.choosing = "";
    const at = this.seats.findIndex((s) => s.id === id);
    const first = partner ? this.seats[(at + 2) % 4].id : id;
    this.broadcast("domino_fx", { type: "opener", by: id, first });
    this.startTurn(first, Math.max(0, this.dealEndsAt - Date.now()));
  }

  private startTurn(id: string, extraMs = 0) {
    this.turn = id;
    this.turnEndsAt = Date.now() + extraMs + this.turnSeconds * 1000;
    this.timer?.clear();
    this.botTimer?.clear();
    const hand = this.hands.get(id)!;
    // Nothing fits and nothing to draw: he passes (shown a moment).
    if (this.forced === null && this.line.first !== null && playable(this.line, hand).length === 0 && this.pile.length === 0) {
      this.timer = this.clock.setTimeout(() => (this.pass(id), this.sync()), extraMs + PASS_MS);
      return;
    }
    this.timer = this.clock.setTimeout(() => (this.timeOut(), this.sync()), extraMs + this.turnSeconds * 1000);
    if (this.seat(id)?.bot) this.botTurn(id, extraMs);
  }

  private next(id: string) {
    return this.seats[(this.seats.findIndex((s) => s.id === id) + 1) % this.seats.length].id;
  }

  private noteLack(id: string) {
    const e = ends(this.line);
    if (!e) return;
    const set = this.lacks.get(id) ?? new Set<number>();
    set.add(e[0]).add(e[1]);
    this.lacks.set(id, set);
  }

  private pass(id: string) {
    if (this.turn !== id || this.phase !== "playing") return;
    this.noteLack(id);
    this.broadcast("domino_fx", { type: "pass", who: id });
    if (++this.passes >= this.seats.length) return this.endRound("", true); // nobody can play: blocked
    this.startTurn(this.next(id));
  }

  private handleDraw(id: string) {
    if (this.phase !== "playing" || this.turn !== id) return;
    const hand = this.hands.get(id)!;
    if (this.forced !== null || this.line.first === null) return "must_play";
    if (playable(this.line, hand).length > 0) return "can_play";
    if (this.pile.length === 0) return;
    this.noteLack(id);
    hand.push(this.pile.pop()!);
    this.broadcast("domino_fx", { type: "draw", who: id });
    // Still nothing fits, and the pile is gone: he passes.
    if (playable(this.line, hand).length === 0 && this.pile.length === 0) {
      this.timer?.clear();
      this.timer = this.clock.setTimeout(() => (this.pass(id), this.sync()), PASS_MS);
    }
  }

  private handlePlay(id: string, tile: number, side?: "left" | "right") {
    if (this.phase !== "playing" || this.turn !== id) return;
    const hand = this.hands.get(id)!;
    if (!hand.includes(tile)) return "bad_tile";
    if (this.forced !== null && tile !== this.forced) return "must_open";
    const sides = sidesFor(this.line, tile);
    if (sides.length === 0) return "no_fit";
    const where = side && sides.includes(side) ? side : sides[0];
    place(this.line, tile, where);
    hand.splice(hand.indexOf(tile), 1);
    this.forced = null;
    this.passes = 0;
    this.broadcast("domino_fx", { type: "play", who: id, tile, side: where });
    if (hand.length === 0) return this.endRound(id, false);
    this.startTurn(this.next(id));
  }

  /** Out of time: the heaviest tile that fits; else draw until one fits; else pass. */
  private timeOut() {
    const id = this.turn;
    const hand = this.hands.get(id);
    if (!hand || this.phase !== "playing") return;
    while (playable(this.line, hand).length === 0 && this.forced === null && this.line.first !== null && this.pile.length > 0) {
      this.handleDraw(id);
    }
    const move = botMove({ level: "normal", hand, line: this.line, forced: this.forced, opponentsLack: new Set(), partnerLacks: new Set() });
    if (move) this.handlePlay(id, move.tile, move.side);
    else this.pass(id);
  }

  private endRound(winner: string, blocked: boolean) {
    this.timer?.clear();
    this.botTimer?.clear();
    const dots: Record<string, number> = {};
    for (const s of this.seats) dots[s.id] = this.hands.get(s.id)!.reduce((n, t) => n + pips(t), 0);
    // Blocked: the player with the fewest dots wins it, in 2 vs 2 for his team (the partners' hands aren't added
    // up). The fewest shared by players of both sides: nobody.
    if (blocked) {
      const best = Math.min(...this.seats.map((s) => dots[s.id]));
      const winners = this.seats.filter((s) => dots[s.id] === best);
      winner = winners.every((w) => this.sameSide(w.id, winners[0].id)) ? winners[0].id : "";
    }
    const points = winner ? this.seats.filter((s) => !this.sameSide(s.id, winner)).reduce((n, s) => n + dots[s.id], 0) : 0;
    if (winner) {
      if (this.teams) {
        this.teamScores[this.teamOf(winner)] += points;
        for (const s of this.seats) s.score = this.teamScores[this.teamOf(s.id)];
      } else {
        this.seat(winner)!.score += points;
      }
    }
    this.lastWinner = winner;
    this.history.push({ round: this.round, winner, blocked, points, dots });
    this.turn = "";
    this.broadcast("domino_fx", { type: "round_end", hands: Object.fromEntries(this.hands) });
    if (this.seats.some((s) => s.score >= this.target)) {
      this.phase = "gameover";
      const won = this.seats.filter((s) => this.sameSide(s.id, winner)).map((s) => s.uid); // the round's winner's side took it
      recordTable("domino", this.seats, won, this.startedAt);
      this.ready = new Set(this.seats.filter(added).map((x) => x.id)); // (the host's bots always play again)
      this.turnEndsAt = Date.now() + CLOSE_AFTER_GAME_MS;
      this.timer = this.clock.setTimeout(() => (this.afterGame(true), this.sync()), CLOSE_AFTER_GAME_MS);
      return;
    }
    this.phase = "round_end";
    this.ready = new Set(this.seats.filter((x) => x.bot).map((x) => x.id));
    this.turnEndsAt = Date.now() + READY_WAIT_MS;
    this.timer = this.clock.setTimeout(() => {
      for (const x of this.seats) this.ready.add(x.id);
      this.allReady();
      this.sync();
    }, READY_WAIT_MS);
    this.allReady();
  }

  private handleReady(id: string) {
    if (this.phase !== "round_end" || !this.seat(id)) return;
    this.ready.add(id);
    this.allReady();
  }

  private allReady() {
    if (this.nextRoundAt || this.seats.some((x) => !this.ready.has(x.id))) return;
    this.timer?.clear();
    this.nextRoundAt = this.turnEndsAt = Date.now() + NEXT_ROUND_MS;
    this.timer = this.clock.setTimeout(() => (this.deal(), this.sync()), NEXT_ROUND_MS);
  }

  // ---- after a match ----

  private handlePlayAgain(id: string) {
    if (this.phase !== "gameover" || !this.seat(id) || this.seat(id)!.bot) return;
    this.ready.add(id);
    this.afterGame(false);
  }

  /**
   * After a match. Everyone at the table pressed "play again": a new match from 0, same table, same settings. One of
   * them left (a bot plays his seat), or the minute is up ([timeUp]): back to the waiting room with whoever pressed,
   * the other seats free (who is still here goes home, as when the room closed). Nobody pressed: the room closes.
   */
  private afterGame(timeUp: boolean) {
    if (this.phase !== "gameover") return;
    const players = this.seats.filter((s) => !added(s));
    if (!timeUp && players.some((s) => !s.bot && !this.ready.has(s.id))) return; // someone may still press
    this.timer?.clear();
    const again = players.filter((s) => this.pressed(s));
    if (again.length === 0) {
      this.abandon.closing = true; // (nobody's seat changes hands on the way out)
      return void this.disconnect().catch(() => {});
    }
    if (again.length === players.length) return this.newMatch();
    this.backToLobby();
  }

  /** The same table again, from 0: the highest double opens it, as a first game. */
  private newMatch() {
    this.clearMatch();
    gameStarted(this.roomName); // (a new game in the admin app's numbers)
    this.deal();
  }

  /** The waiting room again, with whoever pressed "play again" and the host's bots; those watching stay. */
  private backToLobby() {
    for (const s of [...this.seats]) {
      if (added(s) || this.pressed(s)) continue;
      const client = this.connectionOf(s.id);
      this.removeSeat(s.id);
      client?.leave(4000);
    }
    this.clearMatch();
    this.hands.clear();
    this.pile = [];
    this.line = { first: null, left: [], right: [] };
    this.turn = "";
    this.turnEndsAt = 0;
    this.phase = "lobby";
    this.updateListing();
  }

  /** He pressed "play again" and is still here (one who left since is a bot now: he doesn't count). */
  private pressed(s: Seat) {
    return !s.bot && this.ready.has(s.id);
  }

  private clearMatch() {
    this.startedAt = Date.now();
    this.round = 0;
    this.lastWinner = "";
    this.history = [];
    this.teamScores = [0, 0];
    for (const s of this.seats) s.score = 0;
    this.ready.clear();
  }

  // ---- bots ----

  /** A bot's turn: think a moment, draw what it must (one tile at a time), then play. */
  private botTurn(id: string, delayMs = 0) {
    const step = (ms: number) => {
      this.botTimer = this.clock.setTimeout(() => {
        if (this.turn !== id || this.phase !== "playing") return;
        const seat = this.seat(id)!;
        const hand = this.hands.get(id)!;
        const opponentsLack = new Set<number>(), partnerLacks = new Set<number>();
        for (const [who, nums] of this.lacks) {
          if (who === id) continue;
          for (const n of nums) (this.sameSide(who, id) ? partnerLacks : opponentsLack).add(n);
        }
        const move = botMove({ level: seat.bot ?? "normal", hand, line: this.line, forced: this.forced, opponentsLack, partnerLacks });
        if (move) this.handlePlay(id, move.tile, move.side);
        else if (this.pile.length > 0) {
          this.handleDraw(id);
          if (this.turn === id) step(600 * DominoRoom.botSpeed); // one tile at a time, then plays if it fits
        }
        this.sync();
      }, ms);
    };
    step((delayMs + 900 + Math.random() * 900) * DominoRoom.botSpeed);
  }

  // ---- sync ----

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private updateListing() {
    if (!this.listedStarted && this.phase !== "lobby") gameStarted(this.roomName); // (the admin app's numbers)
    this.listedStarted = this.phase !== "lobby";
    // The room's face in the lists is its host's. Mid-game it stays the host the game started with, even after he
    // left (another player may be the host by then, or nobody).
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
        maxPlayers: this.maxPlayers,
        spectators: this.spectators.size,
      },
    });
  }

  private sync() {
    this.abandon.check(this.seats);
    if ((this.phase !== "lobby") !== this.listedStarted) this.updateListing(); // the list learns the game began, or ended
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      maxPlayers: this.maxPlayers,
      turnSeconds: this.turnSeconds,
      target: this.target,
      teams: this.teams,
      round: this.round,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, score: s.score, bot: s.bot ?? "",
        cards: this.hands.get(s.id)?.length ?? 0, team: this.teams ? this.teamOf(s.id) : -1,
      })),
      turn: this.turn,
      choosing: this.choosing,
      turnEndsAt: this.turnEndsAt,
      line: this.line,
      pile: this.pile.length,
      forced: this.forced ?? -1,
      history: this.history,
      ready: [...this.ready],
      nextRoundAt: this.nextRoundAt,
      redeal: this.redeal,
      spectators: this.spectators.size,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      client.send("domino", { ...table, me: this.idOf(client), hand: this.hands.get(this.idOf(client)) ?? [] });
    }
    for (const id of this.admins) this.clients.getById(id)?.send("god", { hands: Object.fromEntries(this.seats.map((s) => [s.id, this.hands.get(s.id) ?? []])) });
  }
}
