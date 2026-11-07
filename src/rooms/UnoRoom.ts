import { sameProClan } from "../clanPro.js";
import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, recordTable, settings, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { COLORS, bestColor, botMove, canPlay, colorOf, isWild, kindOf, newDeck, points, shuffle, type BotLevel, type Color } from "../uno.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSeat, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks, listWatchers } from "./perks.js";
import { gameStarted } from "../metrics.js";
import { StakeTable } from "./stake.js";

/**
 * UNO, 2–8 players (bots included), 7 cards each, one hand a game: the first to play his last card wins, the others
 * are ranked by the points left in their hands. A card goes on the discard pile's top card by color or by kind; a wild
 * goes on anything and its player names the color. Skip, reverse (with 2 players: a skip), +2 and wild +4. The host's
 * stacking rule: a +2 may answer a +2 (and a +4 a +4), the next player taking the sum; off, the next player draws at
 * once and loses his turn. On his turn a player may draw one card: if it goes he may play it, else his turn ends.
 * Down to one card he must have pressed UNO before (or right after, until someone catches him): caught, he draws 2.
 * Then, as at the domino table: "play again" by everyone, a new game; else the waiting room.
 *
 * No schema: each player gets his own "uno" message (the table, plus his cards) after every change, and "uno_fx"
 * for what the apps animate (the deal, plays, draws, UNO, a catch, the end).
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; chat: boolean; started: boolean; players: number; maxPlayers: number; spectators: number; stake: number };
type Settings = { roomType?: string; maxPlayers?: number; turnSeconds?: number; stacking?: boolean; stake?: number };
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
  score: number; // the points left in his hand at the end (the winner: 0)
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a normal bot
};
type Phase = "lobby" | "playing" | "gameover";

const MAX_SEATS = 8;
const ROOM_TYPES = ["public", "friends", "private", "clan"];
const TURN_OPTIONS = [10, 15, 20, 30];
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
const HAND = 7;
const DEAL_MS = 3_000; // the apps' shuffle and deal, before the first turn
const PASS_MS = 1_000; // a drawn card that doesn't go: shown, then the turn moves on
const RECONNECT_SECONDS = 60;
const CLOSE_AFTER_GAME_MS = 60_000;
const MAX_SPECTATORS = 20;

const added = (s: Seat) => s.id.startsWith("bot-");

export class UnoRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this);
  static botSpeed = 1; // tests: bots think faster
  static deck = () => shuffle(newDeck()); // tests: a deal of their choice (cards are drawn from the end)
  maxClients = MAX_SEATS + MAX_SPECTATORS;

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private maxPlayers = 4;
  private turnSeconds = 15;
  private stacking = false;
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
  private drew: string | null = null; // the card the player whose turn it is drew (he may only play that one)
  private called = new Set<string>(); // pressed UNO on two cards
  private unoOpen = ""; // down to one card without UNO: anyone may catch him until the next player moves
  private winner = "";
  private turn = "";
  private turnEndsAt = 0;
  private ready = new Set<string>();
  private botSeq = 0;
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;
  private catchTimer: { clear(): void } | null = null;
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
    on("start_game", (c) => this.handleStart(c));
    on("sit", (c) => this.handleSit(c));
    on<{ card: string; color?: string }>("play", (c, m) => this.handlePlay(this.idOf(c), String(m.card), m.color));
    on("draw", (c) => this.handleDraw(this.idOf(c)));
    on("pass", (c) => this.handlePass(this.idOf(c)));
    on("uno", (c) => this.handleUno(this.idOf(c)));
    on<{ id: string }>("catch", (c, m) => this.handleCatch(this.idOf(c), String(m.id)));
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
    if (n >= 2 && n <= MAX_SEATS) this.maxPlayers = Math.max(n, this.seats.length);
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
    if (typeof s.stacking === "boolean") this.stacking = s.stacking;
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
      bot: BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : "normal",
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
    if (this.seats.length < 2) return "not_enough_players";
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
    seat.bot = "normal";
    seat.connected = true;
    if (this.turn === id && this.phase === "playing") this.startTurn(id);
  }

  // ---- the game ----

  private deal() {
    this.phase = "playing";
    this.pile = UnoRoom.deck();
    this.discard = [];
    this.direction = 1;
    this.pending = 0;
    this.drew = null;
    this.called.clear();
    this.unoOpen = "";
    this.winner = "";
    this.ready.clear();
    for (const s of this.seats) {
      this.hands.set(s.id, []);
      s.score = 0;
    }
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
    this.startTurn(this.seats[Math.floor(Math.random() * this.seats.length)].id, DEAL_MS);
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

  /** Someone else moves: whoever forgot UNO can't be caught any more. */
  private closeCatch(id: string) {
    if (this.unoOpen && this.unoOpen !== id) this.unoOpen = "";
  }

  private handlePlay(id: string, card: string, color?: string) {
    if (this.phase !== "playing" || this.turn !== id) return;
    const hand = this.hands.get(id)!;
    if (!hand.includes(card)) return "bad_card";
    if (this.drew && card !== this.drew) return "drawn_only";
    if (!canPlay(card, this.top, this.color, this.stacking ? this.pending : 0)) return "no_match";
    if (isWild(card) && !COLORS.includes(color as Color)) return "pick_color";
    this.closeCatch(id);
    hand.splice(hand.indexOf(card), 1);
    this.discard.push(card);
    this.color = isWild(card) ? (color as Color) : (colorOf(card) as Color);
    this.broadcast("uno_fx", { type: "play", who: id, card, color: this.color });
    if (hand.length === 0) return this.endGame(id);
    if (hand.length === 1) {
      if (this.called.has(id)) this.broadcast("uno_fx", { type: "uno", who: id });
      else {
        this.unoOpen = id;
        this.botsCatch();
      }
    }
    this.called.delete(id);
    const kind = kindOf(card);
    if (kind === "rev") this.direction = -this.direction;
    if (kind === "draw2" || kind === "draw4") this.pending += kind === "draw2" ? 2 : 4;
    const skip = kind === "skip" || (kind === "rev" && this.seats.length === 2);
    const next = this.after(id, skip ? 2 : 1);
    // Without stacking a +2 or +4 lands at once: the next player draws and loses his turn.
    if (this.pending > 0 && !this.stacking) {
      this.takePending(next);
      return this.startTurn(this.after(next));
    }
    this.startTurn(next);
  }

  private takePending(id: string) {
    const got = this.take(id, this.pending);
    this.broadcast("uno_fx", { type: "draw", who: id, n: got.length, penalty: true });
    this.sendDrawn(id, got);
    this.pending = 0;
  }

  /** The cards he drew, to him only (the others see how many). */
  private sendDrawn(id: string, cards: string[]) {
    this.connectionOf(id)?.send("uno_drawn", { cards });
  }

  private handleDraw(id: string) {
    if (this.phase !== "playing" || this.turn !== id) return;
    this.closeCatch(id);
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
    if (this.phase !== "playing" || !this.seat(by) || by === id || this.unoOpen !== id) return;
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
      this.closeCatch(id);
      const got = this.take(id, 1);
      this.broadcast("uno_fx", { type: "draw", who: id, n: got.length });
      this.sendDrawn(id, got);
    }
    this.startTurn(this.after(id));
  }

  private endGame(winner: string) {
    this.timer?.clear();
    this.botTimer?.clear();
    this.catchTimer?.clear();
    this.winner = winner;
    this.turn = "";
    this.unoOpen = "";
    for (const s of this.seats) s.score = this.hands.get(s.id)!.reduce((n, c) => n + points(c), 0);
    this.broadcast("uno_fx", { type: "end", winner, hands: Object.fromEntries(this.hands) });
    this.phase = "gameover";
    const seat = this.seat(winner)!;
    recordTable("uno", this.seats, seat.uid ? [seat.uid] : [], this.startedAt);
    this.stake.settle([seat.playerId]);
    this.ready = new Set(this.seats.filter(added).map((x) => x.id));
    this.turnEndsAt = Date.now() + CLOSE_AFTER_GAME_MS;
    this.timer = this.clock.setTimeout(() => (this.afterGame(true), this.sync()), CLOSE_AFTER_GAME_MS);
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
      return this.stake.begin(
        players.filter((s) => !s.bot),
        () => {
          if (this.phase !== "gameover") return false;
          this.startedAt = Date.now();
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
    for (const s of this.seats) s.score = 0;
    this.ready.clear();
    this.hands.clear();
    this.pile = [];
    this.discard = [];
    this.winner = "";
    this.turn = "";
    this.turnEndsAt = 0;
    this.phase = "lobby";
    this.updateListing();
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
      const level = seat.bot ?? "normal";
      const hand = this.hands.get(id)!;
      const move = () =>
        botMove({ level, hand, top: this.top, color: this.color, pending: this.stacking ? this.pending : 0, nextCards: this.hands.get(this.after(id))?.length ?? 7 });
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

  /** Someone forgot UNO: a normal or hard bot at the table catches him after a moment, if nobody did first. */
  private botsCatch() {
    const id = this.unoOpen;
    const catcher = this.seats.find((s) => s.bot && s.bot !== "easy" && s.id !== id);
    if (!catcher) return;
    this.catchTimer?.clear();
    this.catchTimer = this.clock.setTimeout(() => (this.handleCatch(catcher.id, id), this.sync()), (1500 + Math.random() * 1500) * UnoRoom.botSpeed);
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
      stacking: this.stacking,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, score: s.score, bot: s.bot ?? "",
        cards: this.hands.get(s.id)?.length ?? 0, team: -1,
      })),
      turn: this.turn,
      turnEndsAt: this.turnEndsAt,
      discard: this.discard.slice(-4), // the top and a few under it
      color: this.color,
      direction: this.direction,
      pending: this.pending,
      pile: this.pile.length,
      unoOpen: this.unoOpen,
      winner: this.winner,
      ready: [...this.ready],
      spectators: this.spectators.size,
      stake: this.stake.amount,
      stakeLast: this.stake.last,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = this.idOf(client);
      client.send("uno", { ...table, me, hand: this.hands.get(me) ?? [], drew: this.turn === me ? this.drew ?? "" : "", called: this.called.has(me) });
    }
    for (const id of this.admins) this.clients.getById(id)?.send("god", { hands: Object.fromEntries(this.seats.map((s) => [s.id, this.hands.get(s.id) ?? []])) });
  }
}
