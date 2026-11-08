import { sameProClan } from "../clanPro.js";
import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, recordTable, settings, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { COLORS, bestColor, botChallenges, botMove, canPlay, colorOf, isWild, kindOf, newDeck, points, shuffle, type BotLevel, type Color } from "../uno.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSeat, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks, listWatchers } from "./perks.js";
import { gameStarted } from "../metrics.js";
import { StakeTable } from "./stake.js";

/**
 * UNO, 2–8 players (bots included), 7 cards each. A match of rounds, as at the domino table: whoever plays his last
 * card wins the round and scores the points left in the others' hands (a number its face, an action 20, a wild 50);
 * the first to the room's target (500–2000) wins the match. 2 vs 2 (4 players): partners face to face, one score per
 * team, the round won by either partner scores the two opponents' hands; each player sees his partner's cards.
 * A card goes on the discard pile's top card by color or by kind; a wild goes on anything and its player names the
 * color. Skip, reverse (with 2 players: a skip), +2 and wild +4. A +4 is only allowed without a card of the color
 * asked, but may be played anyway: the next player draws 4 and loses his turn, or challenges it (no one sees the
 * hand): a bluff, its player draws them instead and the challenger plays; honest, the challenger draws 6 and loses his
 * turn. The host's stacking rule: a +2 may answer a +2 (and a +4 a +4), the next player taking the sum (a challenge
 * judges the last +4: a bluff, its player takes the stack; honest, the challenger the stack and 2 more); off, a +2
 * lands at once (the next player draws and loses his turn). A round's last card a +2 or +4: the next player draws
 * them first (they count), no challenge. Each round has a clock (the host's 3, 5, 7 or 10 minutes): out of time, the
 * lowest hand in points wins (2 vs 2: the lowest pair), scoring the others' hands; even, fewer cards; still even, the
 * one whose turn comes first. On his turn a player may draw one card: if it goes
 * he may play it, else his turn ends. Down to one card he must have pressed UNO before (or right after): forgotten,
 * the other side has 2 s to hit the hammer over him, and caught, he draws 2. Then, as at the domino table: "play
 * again" by everyone, a new match; else the waiting room.
 *
 * No schema: each player gets his own "uno" message (the table, plus his cards and his partner's) after every change,
 * and "uno_fx" for what the apps animate (the deal, plays, draws, UNO, a catch, a round's end).
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; chat: boolean; started: boolean; players: number; maxPlayers: number; spectators: number; stake: number };
type Settings = { roomType?: string; maxPlayers?: number; turnSeconds?: number; roundMinutes?: number; stacking?: boolean; target?: number; teams?: boolean; stake?: number };
type JoinOptions = Settings & { admin?: boolean; name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number;
  vip?: string;
  connected: boolean;
  score: number; // the match's points (2 vs 2: his team's)
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a bot
};
type Phase = "lobby" | "playing" | "round_end" | "gameover";
type RoundResult = { round: number; winner: string; points: number; left: Record<string, number>; timeUp?: boolean }; // left: each hand's points

const MAX_SEATS = 8;
const ROOM_TYPES = ["public", "friends", "private", "clan"];
const TURN_OPTIONS = [10, 15, 20, 30];
const ROUND_OPTIONS = [3, 5, 7, 10]; // minutes
const TARGET_OPTIONS = [500, 1000, 1500, 2000];
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
const HAND = 7;
const DEAL_MS = 3_000; // the apps' deal, before the first turn
const PASS_MS = 1_000; // a drawn card that doesn't go: shown, then the turn moves on
const CATCH_MS = 2_000; // UNO forgotten: the others' time to hit the hammer
const READY_WAIT_MS = 30_000; // between rounds: who hasn't pressed "ready" by then is ready anyway
const NEXT_ROUND_MS = 5_000;
const RECONNECT_SECONDS = 60;
const CLOSE_AFTER_GAME_MS = 60_000;
const MAX_SPECTATORS = 20;

const added = (s: Seat) => s.id.startsWith("bot-");

export class UnoRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this);
  static botSpeed = 1; // tests: bots think faster
  static pace = 1; // tests: the deal and the pause between rounds shorter
  static deck = () => shuffle(newDeck()); // tests: a deal of their choice (cards are drawn from the end)
  static roundScale = 1; // tests: the round's clock shorter
  maxClients = MAX_SEATS + MAX_SPECTATORS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private maxPlayers = 4;
  private turnSeconds = 15;
  private roundMinutes = 5;
  private stacking = false;
  private target = 500;
  private teams = false; // 2 vs 2: seats 0 & 2 against 1 & 3 (partners face to face)
  private teamScores = [0, 0];
  private startedAt = 0;
  private seats: Seat[] = []; // seat order = turn order (clockwise)
  private members = new Map<string, string>();
  private invited = new Set<string>();
  private banned = new Map<string, string>();
  private spectators = new Map<string, JoinOptions>();
  private tableTalk!: TableTalk;
  private admins = new Set<string>();
  private returned = new Map<string, string>();
  private listedStarted = false;
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" };
  private kicks = new Kicks(this);
  private looks = new RoomLooks();
  private get look() {
    return this.looks.of(this.hostId);
  }
  private hands = new Map<string, string[]>();
  private pile: string[] = []; // face down: drawn from its end
  private discard: string[] = []; // face up: its last card is the top
  private color: Color = "r"; // the color asked (a wild's named one)
  private direction = 1; // 1 clockwise, -1 after a reverse
  private pending = 0; // +2s and +4s stacked, for the next player to draw
  private d4: { who: string; bluff: boolean } | null = null; // the last +4, while the next player may challenge it
  private drew: string | null = null; // the card the player whose turn it is drew (he may only play that one)
  private called = new Set<string>(); // pressed UNO on two cards
  private unoOpen = ""; // down to one card without UNO: the other side may catch him for CATCH_MS
  private round = 0;
  private starter = -1; // the seat that played first this round (the next round: the one after)
  private winner = ""; // the last round's
  private history: RoundResult[] = [];
  private turn = "";
  private turnEndsAt = 0;
  private roundEndsAt = 0;
  private nextRoundAt = 0;
  private ready = new Set<string>();
  private botSeq = 0;
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;
  private catchTimer: { clear(): void } | null = null;
  private roundTimer: { clear(): void } | null = null;
  private stake = new StakeTable("uno", this);

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
        if (error) client.send("uno_error", { code: error });
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
    on<{ card: string; color?: string }>("play", (c, m) => this.handlePlay(this.idOf(c), String(m.card), m.color));
    on("draw", (c) => this.handleDraw(this.idOf(c)));
    on("pass", (c) => this.handlePass(this.idOf(c)));
    on("challenge", (c) => this.handleChallenge(this.idOf(c)));
    on("uno", (c) => this.handleUno(this.idOf(c)));
    on<{ id: string }>("catch", (c, m) => this.handleCatch(this.idOf(c), String(m.id)));
    on("ready", (c) => this.handleReady(this.idOf(c)));
    on("play_again", (c) => this.handlePlayAgain(this.idOf(c)));
    on<{ id: string }>("kick", (c, m) => void this.handleKick(c, m.id));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.onMessage("room_look", (client, msg) => this.handleLook(client, msg));
    listWatchers(this, (c) => this.spectators.has(this.idOf(c)));
    this.tableTalk = new TableTalk(this, (c) => this.seat(this.idOf(c)), (c) => this.idOf(c));
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
      if (this.seats.length >= this.maxPlayers) throw new ServerError(4409, "full");
      const stake = this.stake.joinError(account);
      if (stake) throw new ServerError(4402, stake);
    }
    if (this.roomType !== "public" && !this.seats.every((s) => s.bot)) {
      const ok =
        (account && this.invited.has(account.uid)) ||
        (this.roomType === "friends" && account && (await isFriendOfAny(account.uid, [...new Set(this.members.values())]))) ||
        (this.roomType === "clan" && account && (await sameProClan(account.uid, [...new Set(this.members.values())])));
      if (!ok) throw new ServerError(4410, this.roomType);
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
      score: 0,
      bot: null,
    });
    if (!this.hostId) this.hostId = this.idOf(client);
  }

  private handleSit(client: Client) {
    const options = this.spectators.get(this.idOf(client));
    if (this.phase !== "lobby" || !options) return;
    if (this.seats.length >= this.maxPlayers) return "full";
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
    if (this.turn === seat.id) this.botTimer?.clear();
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
      if (this.voiceOn) dropFromVoice(this.roomId, client.sessionId).catch(() => {});
      return;
    }
    const id = this.idOf(client);
    this.returned.delete(client.sessionId);
    const uid = this.members.get(id);
    this.members.delete(id);
    if (uid) leaveRoom(uid, this.roomId);
    if (this.voiceOn) dropFromVoice(this.roomId, id).catch(() => {});
    if (this.spectators.delete(id)) {
      this.updateListing();
      return this.sync();
    }
    if (this.abandon.closing) return;
    if (this.phase === "lobby") this.removeSeat(id);
    else {
      this.stake.leave(this.seat(id)?.playerId ?? "");
      this.becomeBot(id);
    }
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && this.connectionOf(s.id))?.id ?? "";
    this.afterGame(false);
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.stake.refund();
    this.timer?.clear();
    this.botTimer?.clear();
    this.catchTimer?.clear();
    if (this.voiceOn) closeVoice(this.roomId).catch(() => {});
  }

  private async handleVoiceJoin(client: Client) {
    if (!this.voiceOn) return client.send("voice", { enabled: false, chat: this.chatOnly });
    if (this.admins.has(client.sessionId)) {
      return client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, "admin", { talk: false, hear: true }, false, true)) });
    }
    const name = this.seat(this.idOf(client))?.name ?? client.auth?.account?.name ?? "spectator";
    const talk = !!this.seat(this.idOf(client)) || client.auth?.account?.vipPro === true;
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, this.idOf(client), name, { talk, hear: true })) });
  }

  // ---- the waiting room ----

  private applySettings(s: Settings) {
    const n = Math.floor(Number(s.maxPlayers));
    if (n >= 2 && n <= MAX_SEATS && !(this.teams && n !== 4)) this.maxPlayers = Math.max(n, this.seats.length);
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
    if (ROUND_OPTIONS.includes(Number(s.roundMinutes))) this.roundMinutes = Number(s.roundMinutes);
    if (TARGET_OPTIONS.includes(Number(s.target))) this.target = Number(s.target);
    if (typeof s.stacking === "boolean") this.stacking = s.stacking;
    if (typeof s.teams === "boolean") this.teams = s.teams && this.seats.length <= 4;
    if (this.teams) this.maxPlayers = 4;
    if (s.stake !== undefined && !(Number(s.stake) > 0 && this.seats.some((x) => x.bot))) this.stake.set(s.stake);
    this.updateListing();
  }

  private handleAddBot(client: Client, level: string) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || this.seats.length >= this.maxPlayers) return;
    if (settings().bots["uno"] === false) return "bots_off";
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
      score: 0,
      bot: BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : "hard",
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
    this.stake.begin(
      this.seats.filter((s) => !s.bot),
      () => {
        if (this.phase !== "lobby" || this.seats.length < 2) return false;
        this.startedAt = Date.now();
        this.deal();
        this.sync();
      },
      (why) => (client.send("uno_error", why), this.sync()),
    );
  }

  private async handleKick(client: Client, id: string) {
    const seat = this.seat(id), by = this.seat(this.idOf(client));
    if (this.phase !== "lobby" || !by || !seat || seat === by || !!seat.bot) return;
    const how = await this.kicks.decide(by, by.name, by.id === this.hostId, seat, this.connectionOf(id));
    if (typeof how === "object") return client.send("uno_error", how);
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
    seat.bot = "hard";
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

  /** 2 vs 2: the seat facing him. */
  private partnerOf(id: string) {
    const at = this.seats.findIndex((x) => x.id === id);
    return this.teams && this.seats.length === 4 && at >= 0 ? this.seats[(at + 2) % 4].id : "";
  }

  // ---- a round ----

  private deal() {
    this.round++;
    this.phase = "playing";
    this.pile = UnoRoom.deck();
    this.discard = [];
    this.direction = 1;
    this.pending = 0;
    this.d4 = null;
    this.drew = null;
    this.called.clear();
    this.unoOpen = "";
    this.winner = "";
    this.ready.clear();
    this.nextRoundAt = 0;
    for (const s of this.seats) this.hands.set(s.id, []);
    for (let i = 0; i < HAND; i++) for (const s of this.seats) this.hands.get(s.id)!.push(this.pile.pop()!);
    // The first card up: a number card (anything else goes back under the pile).
    let top = this.pile.pop()!;
    while (!/^\d$/.test(kindOf(top))) {
      this.pile.unshift(top);
      top = this.pile.pop()!;
    }
    this.discard.push(top);
    this.color = colorOf(top) as Color;
    this.broadcast("uno_fx", { type: "deal", order: this.seats.map((s) => s.id), top });
    // The first round: anyone; then each round the next seat round the table.
    this.starter = this.starter < 0 ? Math.floor(Math.random() * this.seats.length) : (this.starter + 1) % this.seats.length;
    this.startTurn(this.seats[this.starter].id, DEAL_MS * UnoRoom.pace);
    // The round's clock, from the first turn.
    const roundMs = DEAL_MS * UnoRoom.pace + this.roundMinutes * 60_000 * UnoRoom.roundScale;
    this.roundEndsAt = Date.now() + roundMs;
    this.roundTimer?.clear();
    this.roundTimer = this.clock.setTimeout(() => (this.timeUp(), this.sync()), roundMs);
  }

  /** The round's time is up: the lowest hand in points wins (2 vs 2: the pair's); even, fewer cards; still even, the
   *  one whose turn comes first. */
  private timeUp() {
    if (this.phase !== "playing") return;
    const side = (id: string, of: (cards: string[]) => number) =>
      this.seats.filter((s) => this.sameSide(s.id, id)).reduce((n, s) => n + of(this.hands.get(s.id)!), 0);
    const pts = (id: string) => side(id, (h) => h.reduce((n, c) => n + points(c), 0));
    const cards = (id: string) => side(id, (h) => h.length);
    const order = [this.turn || this.seats[0].id];
    while (order.length < this.seats.length) order.push(this.after(order[order.length - 1]));
    const winner = order.reduce((best, id) =>
      pts(id) < pts(best) || (pts(id) === pts(best) && cards(id) < cards(best)) ? id : best,
    );
    this.endRound(winner, true);
  }

  private startTurn(id: string, extraMs = 0) {
    this.turn = id;
    this.drew = null;
    this.turnEndsAt = Date.now() + extraMs + this.turnSeconds * 1000;
    this.timer?.clear();
    this.botTimer?.clear();
    this.timer = this.clock.setTimeout(() => (this.timeOut(), this.sync()), extraMs + this.turnSeconds * 1000);
    if (this.seat(id)?.bot) this.botTurn(id, extraMs);
  }

  /** [steps] seats on from [id], the way play goes. */
  private after(id: string, steps = 1) {
    const n = this.seats.length;
    const at = this.seats.findIndex((s) => s.id === id);
    return this.seats[(((at + steps * this.direction) % n) + n) % n].id;
  }

  private get top() {
    return this.discard[this.discard.length - 1];
  }

  /** [n] cards from the pile (gone: the discard pile but its top, shuffled); as many as there are. */
  private take(id: string, n: number) {
    const hand = this.hands.get(id)!;
    const got: string[] = [];
    for (let i = 0; i < n; i++) {
      if (this.pile.length === 0) {
        const top = this.discard.pop()!;
        this.pile = shuffle(this.discard);
        this.discard = [top];
      }
      const card = this.pile.pop();
      if (!card) break;
      hand.push(card);
      got.push(card);
    }
    if (hand.length > 1) this.called.delete(id);
    if (this.unoOpen === id && hand.length > 1) this.unoOpen = "";
    return got;
  }

  private handlePlay(id: string, card: string, color?: string) {
    if (this.phase !== "playing" || this.turn !== id) return;
    const hand = this.hands.get(id)!;
    if (!hand.includes(card)) return "bad_card";
    if (this.drew && card !== this.drew) return "drawn_only";
    if (this.pending > 0 && !this.stacking) return "no_match"; // (a +4 waits: challenge it, or draw)
    if (!canPlay(card, this.top, this.color, this.stacking ? this.pending : 0)) return "no_match";
    if (isWild(card) && !COLORS.includes(color as Color)) return "pick_color";
    hand.splice(hand.indexOf(card), 1);
    const kind = kindOf(card);
    this.d4 = kind === "draw4" ? { who: id, bluff: hand.some((c) => colorOf(c) === this.color) } : null;
    this.discard.push(card);
    this.color = isWild(card) ? (color as Color) : (colorOf(card) as Color);
    this.broadcast("uno_fx", { type: "play", who: id, card, color: this.color });
    if (kind === "draw2" || kind === "draw4") this.pending += kind === "draw2" ? 2 : 4;
    if (hand.length === 0) {
      // Out with a +2 or +4: the next player draws them first, and they count.
      if (this.pending > 0) this.takePending(this.after(id));
      return this.endRound(id);
    }
    if (hand.length === 1) {
      if (this.called.has(id)) this.broadcast("uno_fx", { type: "uno", who: id });
      else this.openCatch(id);
    }
    this.called.delete(id);
    if (kind === "rev") this.direction = -this.direction;
    const skip = kind === "skip" || (kind === "rev" && this.seats.length === 2);
    const next = this.after(id, skip ? 2 : 1);
    // Without stacking a +2 lands at once: the next player draws and loses his turn (a +4 waits: draw, or challenge).
    if (kind === "draw2" && !this.stacking) {
      this.takePending(next);
      return this.startTurn(this.after(next));
    }
    this.startTurn(next);
  }

  private takePending(id: string, extra = 0) {
    const got = this.take(id, this.pending + extra);
    this.broadcast("uno_fx", { type: "draw", who: id, n: got.length, penalty: true });
    this.sendDrawn(id, got);
    this.pending = 0;
    this.d4 = null;
  }

  /** The last +4 called a bluff. It was: its player draws the stack, the challenger plays. It wasn't: the challenger
   *  draws the stack and 2 more, his turn over. */
  private handleChallenge(id: string) {
    const d4 = this.d4;
    if (this.phase !== "playing" || this.turn !== id || !d4) return;
    this.broadcast("uno_fx", { type: "challenge", by: id, who: d4.who, bluff: d4.bluff });
    if (d4.bluff) {
      this.takePending(d4.who);
      return this.startTurn(id);
    }
    this.takePending(id, 2);
    this.startTurn(this.after(id));
  }

  /** The cards he drew, to him only (the others see how many). */
  private sendDrawn(id: string, cards: string[]) {
    this.connectionOf(id)?.send("uno_drawn", { cards });
  }

  private handleDraw(id: string) {
    if (this.phase !== "playing" || this.turn !== id) return;
    // A stack waits for him: he takes it all, and his turn is over.
    if (this.pending > 0) {
      this.takePending(id);
      return this.startTurn(this.after(id));
    }
    if (this.drew) return "already_drew";
    const [card] = this.take(id, 1);
    this.broadcast("uno_fx", { type: "draw", who: id, n: card ? 1 : 0 });
    if (!card) return this.startTurn(this.after(id)); // (no card left anywhere)
    this.sendDrawn(id, [card]);
    this.drew = card;
    // It doesn't go: shown a moment, then the next player.
    if (!canPlay(card, this.top, this.color)) {
      this.timer?.clear();
      this.timer = this.clock.setTimeout(() => (this.handlePass(id), this.sync()), PASS_MS);
    }
  }

  /** After drawing, he keeps the card. */
  private handlePass(id: string) {
    if (this.phase !== "playing" || this.turn !== id || !this.drew) return;
    this.startTurn(this.after(id));
  }

  /** UNO: on two cards before playing the second last, or on one card before anyone caught him. */
  private handleUno(id: string) {
    const hand = this.hands.get(id);
    if (this.phase !== "playing" || !hand) return;
    if (hand.length === 2 && this.turn === id) this.called.add(id);
    else if (hand.length === 1 && this.unoOpen === id) {
      this.unoOpen = "";
      this.catchTimer?.clear();
      this.broadcast("uno_fx", { type: "uno", who: id });
    }
  }

  private handleCatch(by: string, id: string) {
    if (this.phase !== "playing" || !this.seat(by) || this.sameSide(by, id) || this.unoOpen !== id) return;
    this.unoOpen = "";
    this.catchTimer?.clear();
    const got = this.take(id, 2);
    this.broadcast("uno_fx", { type: "caught", who: id, by, n: got.length });
    this.sendDrawn(id, got);
  }

  /** Out of time: a stack taken, or the card he drew kept, or one card drawn; the turn moves on. */
  private timeOut() {
    const id = this.turn;
    if (this.phase !== "playing" || !this.hands.get(id)) return;
    if (this.pending > 0) return this.handleDraw(id);
    if (!this.drew) {
      const got = this.take(id, 1);
      this.broadcast("uno_fx", { type: "draw", who: id, n: got.length });
      this.sendDrawn(id, got);
    }
    this.startTurn(this.after(id));
  }

  /** [winner] played his last card: he (2 vs 2: his team) scores the points left in the other side's hands. */
  private endRound(winner: string, timeUp = false) {
    this.timer?.clear();
    this.botTimer?.clear();
    this.catchTimer?.clear();
    this.roundTimer?.clear();
    this.roundEndsAt = 0;
    this.winner = winner;
    this.turn = "";
    this.unoOpen = "";
    const left: Record<string, number> = {};
    for (const s of this.seats) left[s.id] = this.hands.get(s.id)!.reduce((n, c) => n + points(c), 0);
    const won = this.seats.filter((s) => !this.sameSide(s.id, winner)).reduce((n, s) => n + left[s.id], 0);
    if (this.teams) {
      this.teamScores[this.teamOf(winner)] += won;
      for (const s of this.seats) s.score = this.teamScores[this.teamOf(s.id)];
    } else this.seat(winner)!.score += won;
    this.history.push({ round: this.round, winner, points: won, left, ...(timeUp ? { timeUp } : {}) });
    this.broadcast("uno_fx", { type: "end", winner, hands: Object.fromEntries(this.hands), timeUp });
    if (this.seats.some((s) => s.score >= this.target)) {
      this.phase = "gameover";
      const side = this.seats.filter((s) => this.sameSide(s.id, winner));
      recordTable("uno", this.seats, side.map((s) => s.uid).filter(Boolean), this.startedAt);
      this.stake.settle(side.map((s) => s.playerId));
      this.ready = new Set(this.seats.filter(added).map((x) => x.id));
      this.turnEndsAt = Date.now() + CLOSE_AFTER_GAME_MS;
      this.timer = this.clock.setTimeout(() => (this.afterGame(true), this.sync()), CLOSE_AFTER_GAME_MS);
      return;
    }
    this.phase = "round_end";
    this.ready = new Set(this.seats.filter((x) => x.bot).map((x) => x.id));
    this.turnEndsAt = Date.now() + READY_WAIT_MS * UnoRoom.pace;
    this.timer = this.clock.setTimeout(() => {
      for (const x of this.seats) this.ready.add(x.id);
      this.allReady();
      this.sync();
    }, READY_WAIT_MS * UnoRoom.pace);
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
    this.nextRoundAt = this.turnEndsAt = Date.now() + NEXT_ROUND_MS * UnoRoom.pace;
    this.timer = this.clock.setTimeout(() => (this.deal(), this.sync()), NEXT_ROUND_MS * UnoRoom.pace);
  }

  // ---- after a match (as at the domino table) ----

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
      return this.stake.begin(
        players.filter((s) => !s.bot),
        () => {
          if (this.phase !== "gameover") return false;
          this.clearMatch();
          gameStarted(this.roomName);
          this.deal();
          this.sync();
        },
        (why) => (this.broadcast("uno_error", why), this.backToLobby(), this.sync()),
      );
    }
    this.backToLobby();
  }

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
    this.discard = [];
    this.turn = "";
    this.turnEndsAt = 0;
    this.phase = "lobby";
    this.updateListing();
  }

  private clearMatch() {
    this.startedAt = Date.now();
    this.round = 0;
    this.starter = -1;
    this.winner = "";
    this.history = [];
    this.teamScores = [0, 0];
    for (const s of this.seats) s.score = 0;
    this.ready.clear();
  }

  private pressed(s: Seat) {
    return !s.bot && this.ready.has(s.id);
  }

  // ---- bots ----

  /** A bot's turn: think a moment; UNO on two cards (an easy one forgets now and then); play, or draw and maybe play. */
  private botTurn(id: string, delayMs = 0) {
    this.botTimer = this.clock.setTimeout(() => {
      if (this.turn !== id || this.phase !== "playing") return;
      const seat = this.seat(id)!;
      const level = seat.bot ?? "hard";
      const hand = this.hands.get(id)!;
      const move = () =>
        botMove({ level, hand, top: this.top, color: this.color, pending: this.stacking ? this.pending : 0, nextCards: this.hands.get(this.after(id))?.length ?? 7 });
      // A +4 waits for it: stack one if it may, else challenge it now and then, or draw.
      if (this.d4 && !(this.stacking && move())) {
        if (botChallenges(level, this.hands.get(this.d4.who)!.length)) this.handleChallenge(id);
        else this.handleDraw(id);
        return this.sync();
      }
      let m = move();
      if (!m) {
        this.handleDraw(id);
        if (this.turn !== id || !this.drew) return this.sync();
        const drawn = this.drew;
        m = canPlay(drawn, this.top, this.color) ? { card: drawn, color: isWild(drawn) ? bestColor(hand.filter((c) => c !== drawn)) : undefined } : null;
        if (!m) return this.sync(); // (it passes by itself)
      }
      if (hand.length === 2 && (level !== "easy" || Math.random() < 0.7)) this.handleUno(id);
      this.handlePlay(id, m.card, m.color ?? (isWild(m.card) ? "r" : undefined));
      this.sync();
    }, (delayMs + 900 + Math.random() * 900) * UnoRoom.botSpeed);
  }

  /** [id] forgot UNO: the other side has CATCH_MS to hit the hammer; a bot of that side does it in time. */
  private openCatch(id: string) {
    this.unoOpen = id;
    const catcher = this.seats.find((s) => s.bot && s.bot !== "easy" && !this.sameSide(s.id, id));
    this.catchTimer?.clear();
    this.catchTimer = this.clock.setTimeout(
      () => {
        if (catcher) this.handleCatch(catcher.id, id);
        else if (this.unoOpen === id) this.unoOpen = "";
        this.sync();
      },
      catcher ? (900 + Math.random() * 800) * UnoRoom.botSpeed : CATCH_MS,
    );
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
        chat: this.chatOnly,
        started: this.phase !== "lobby",
        players: this.seats.length,
        maxPlayers: this.maxPlayers,
        spectators: this.spectators.size,
        stake: this.stake.amount,
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
      chat: this.chatOnly,
      maxPlayers: this.maxPlayers,
      turnSeconds: this.turnSeconds,
      roundMinutes: this.roundMinutes,
      roundEndsAt: this.roundEndsAt,
      stacking: this.stacking,
      target: this.target,
      teams: this.teams,
      round: this.round,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, score: s.score, bot: s.bot ?? "",
        cards: this.hands.get(s.id)?.length ?? 0, team: this.teams ? this.teamOf(s.id) : -1,
      })),
      turn: this.turn,
      turnEndsAt: this.turnEndsAt,
      nextRoundAt: this.nextRoundAt,
      discard: this.discard.slice(-4), // the top and a few under it
      color: this.color,
      direction: this.direction,
      pending: this.pending,
      challenge: this.d4?.who ?? "", // a +4 the next player may challenge (whose; never whether it's a bluff)
      pile: this.pile.length,
      unoOpen: this.unoOpen,
      winner: this.winner,
      history: this.history,
      ready: [...this.ready],
      spectators: this.spectators.size,
      stake: this.stake.amount,
      stakeLast: this.stake.last,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = this.idOf(client);
      const partner = this.seat(me) ? this.partnerOf(me) : "";
      client.send("uno", {
        ...table,
        me,
        hand: this.hands.get(me) ?? [],
        partnerHand: partner ? (this.hands.get(partner) ?? []) : [],
        drew: this.turn === me ? (this.drew ?? "") : "",
        called: this.called.has(me),
      });
    }
    for (const id of this.admins) this.clients.getById(id)?.send("god", { hands: Object.fromEntries(this.seats.map((s) => [s.id, this.hands.get(s.id) ?? []])) });
  }
}
