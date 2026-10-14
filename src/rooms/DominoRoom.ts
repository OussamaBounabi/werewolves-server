import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isFriendOfAny, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import {
  botMove, ends, opener, pips, place, playable, shuffledTiles, sidesFor, type BotLevel, type Line,
} from "../domino.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon } from "./abandoned.js";

/**
 * Dominoes, 2–4 players (bots included), double six: 7 tiles each; with fewer than 4 players the rest
 * is the pile (on the empty chair). A player with no tile that fits draws until one does — or passes
 * once the pile is empty. Round 1 starts with the highest double (6-6), then the last winner starts.
 * Whoever plays his last tile scores every dot left in the opponents' hands; when nobody can play,
 * the fewest dots wins (a tie: nobody scores). 2 vs 2: partners face to face, one score per team; blocked, the
 * single lightest hand of the four wins for its team.
 * The first to the room's target wins the match.
 *
 * No schema: each player gets his own "domino" message (the table, plus his tiles) after every change,
 * and "domino_fx" for what the apps animate (the deal, draws, plays, passes).
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type Settings = { roomType?: string; maxPlayers?: number; turnSeconds?: number; target?: number; teams?: boolean };
type JoinOptions = Settings & { name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number; // the animated frame he wears, 0 none
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
const RECONNECT_SECONDS = 600;
const CLOSE_AFTER_GAME_MS = 60_000;

const MAX_SPECTATORS = 20;

export class DominoRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this); // nobody left to play: the room closes by itself
  static botSpeed = 1; // tests: bots think faster
  maxClients = MAX_SEATS + MAX_SPECTATORS; // the seats are counted in onAuth

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private maxPlayers = 4;
  private turnSeconds = 30;
  private target = 150;
  private teams = false; // 2 vs 2: seats 0 & 2 against 1 & 3 (partners face to face)
  private teamScores = [0, 0];
  private seats: Seat[] = []; // seat order = turn order
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private spectators = new Map<string, JoinOptions>(); // sessionId → how he came: watching a game, without a seat
  private returned = new Map<string, string>(); // a returning player's new connection → the seat he had
  private listedStarted = false; // what the room list was last told
  private hands = new Map<string, number[]>();
  private pile: number[] = [];
  private line: Line = { first: null, left: [], right: [] };
  private forced: number | null = null; // the tile the round must start with (round 1: the highest double)
  private passes = 0; // passes in a row: everyone passed = blocked
  private lacks = new Map<string, Set<number>>(); // numbers each player showed he has none of (bots)
  private round = 0;
  private lastWinner = "";
  private turn = "";
  private turnEndsAt = 0;
  private history: RoundResult[] = [];
  private ready = new Set<string>();
  private nextRoundAt = 0;
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
    on("ready", (c) => this.handleReady(this.idOf(c)));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (this.seat(this.idOf(client)) && typeof msg?.uid === "string") this.invited.add(msg.uid);
    });
    this.updateListing();
  }

  // ---- joining (as at the rummy table) ----

  async onAuth(_client: Client, options: JoinOptions = {}): Promise<{ account: Account | null }> {
    let account: Account | null = null;
    if (options.idToken && accountsEnabled) {
      try {
        account = await accountFor(String(options.idToken));
      } catch {
        throw new ServerError(4401, "auth");
      }
    }
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
    const account: Account | null = client.auth?.account ?? null;
    const back = this.seatLeftBy(account?.uid ?? String(options.playerId ?? ""));
    if (back) this.returned.set(client.sessionId, back.id); // (first: everything below files him under his seat's id)
    if (account) {
      this.members.set(this.idOf(client), account.uid);
      enterRoom(account.uid, this.roomName, this.roomId);
    }
    if (back) this.retakeSeat(back);
    else if (options.spectator) this.spectators.set(this.idOf(client), options);
    else this.addSeat(client, options);
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
    if (this.spectators.has(this.idOf(client))) return; // no seat to hold: onLeave runs next
    const seat = this.seat(this.idOf(client));
    if (seat) seat.connected = false;
    Promise.resolve(this.allowReconnection(client, RECONNECT_SECONDS)).catch(() => {});
    this.sync();
  }

  onReconnect(client: Client) {
    const seat = this.seat(this.idOf(client));
    if (seat) seat.connected = true;
    this.sync();
  }

  onLeave(client: Client) {
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
    else if (this.phase !== "gameover") this.becomeBot(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && this.connectionOf(s.id))?.id ?? "";
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
    const name = this.seat(this.idOf(client))?.name ?? client.auth?.account?.name ?? "spectator";
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, this.idOf(client), name, { talk: !!this.seat(this.idOf(client)), hear: true })) });
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
    this.deal();
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

  private deal() {
    this.round++;
    this.phase = "playing";
    const tiles = shuffledTiles();
    for (const s of this.seats) this.hands.set(s.id, []);
    for (let i = 0; i < HAND; i++) for (const s of this.seats) this.hands.get(s.id)!.push(tiles.pop()!);
    this.pile = tiles; // 4 players: empty
    this.line = { first: null, left: [], right: [] };
    this.passes = 0;
    this.lacks.clear();
    this.ready.clear();
    this.nextRoundAt = 0;
    // Round 1 (or after a tie): the highest double starts, with it. Then the last winner, any tile.
    const winner = this.seat(this.lastWinner);
    let first: string;
    if (winner) {
      first = winner.id;
      this.forced = null;
    } else {
      const open = opener(this.hands)!;
      first = open.id;
      this.forced = open.tile;
    }
    this.broadcast("domino_fx", { type: "deal", order: this.seats.map((s) => s.id), pile: this.pile.length });
    this.startTurn(first, DEAL_MS);
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
      this.turnEndsAt = 0;
      this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
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
    this.listedStarted = this.phase !== "lobby";
    this.setMatchmaking({
      metadata: {
        host: this.seat(this.hostId)?.name ?? "",
        hostAvatar: this.seat(this.hostId)?.avatar ?? 0,
        hostFrame: this.seat(this.hostId)?.frame ?? 0,
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
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, connected: s.connected, score: s.score, bot: s.bot ?? "",
        cards: this.hands.get(s.id)?.length ?? 0, team: this.teams ? this.teamOf(s.id) : -1,
      })),
      turn: this.turn,
      turnEndsAt: this.turnEndsAt,
      line: this.line,
      pile: this.pile.length,
      forced: this.forced ?? -1,
      history: this.history,
      ready: [...this.ready],
      nextRoundAt: this.nextRoundAt,
      spectators: this.spectators.size,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      client.send("domino", { ...table, me: this.idOf(client), hand: this.hands.get(this.idOf(client)) ?? [] });
    }
  }
}
