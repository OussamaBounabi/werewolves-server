import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, firebaseEnabled, isFriendOfAny, setRoom, type Account } from "../firebase.js";
import {
  DEFAULT_RULES, isJoker, jokerFits, rankOf, suitOf, layError, meldOf, openingError, openingPoints, shuffled, teamLayError, type MeldKind,
  type Rules,
} from "../rummy.js";
import { planTurn, wantsDiscard, type BotLevel, type BotView } from "../rummyBot.js";
import { closeVoice, dropFromVoice, voiceEnabled, voiceToken } from "../voice.js";

/**
 * Algerian rummy, 2–5 players (bots included), 14 cards each (the round's first player gets 15 and
 * starts by discarding). A turn: draw from the deck — or take the top discard, only to lay it down
 * this turn — then lay down / add to melds, then discard one card. The first lay-down must reach the
 * threshold (by default 101 for 2–3 players, 91 for 4, 71 for 5) counting only melds without a joker.
 * The first player to get rid of every card wins the round: the others take 10 points per card left,
 * 200 if they never laid down, doubled when the winner's last card is a joker. The first to reach the
 * score limit ends the game; the lowest total wins.
 *
 * No schema: each player gets his own "rummy" message (the table, plus his hand) after every change,
 * and "rummy_fx" for what the apps animate (the deal, draws, discards).
 */
type Meta = { host: string; hostAvatar: number; hostFrame: number; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type Settings = {
  roomType?: string;
  maxPlayers?: number;
  turnSeconds?: number;
  losingScore?: number;
  openPoints?: number;
  rules?: Partial<Rules>;
  teams?: boolean; // 2 vs 2 (4 players): partners sit face to face, one score per team
};
type JoinOptions = Settings & { name?: string; playerId?: string; idToken?: string };
type Seat = {
  id: string; // the session id (a bot's own id)
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number; // the animated frame he wears, 0 none
  connected: boolean;
  score: number;
  bot: BotLevel | null; // a player who leaves mid-game is replaced by a normal bot
};
type TableMeld = { id: number; owner: string; kind: MeldKind; cards: number[] };
type Phase = "lobby" | "seating" | "playing" | "round_end" | "gameover"; // seating: drawing for seats
type RoundResult = { winner: string; joker: boolean; penalties: Record<string, number> };

const MAX_SEATS = 5;
const ROOM_TYPES = ["public", "friends", "private"];
const TURN_OPTIONS = [30, 45, 60, 90];
const SCORE_OPTIONS = [500, 1000, 1500, 2000, 3000];
const OPEN_OPTIONS = [0, 51, 71, 91, 101]; // 0: by the number of players
const BOT_LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];
const HAND = 14;
const NEVER_OPENED = 100, PER_CARD = 10; // a hand that never laid down / each card left; doubled by a joker finish
const DEAL_MS = 3_200; // the apps' deal animation, before the first turn
const LAY_MS = 350; // the apps' lay-down animation, per meld
const PICK_MS = 10_000; // the seat draw: time to pick a card
const PICKS_SHOWN_MS = 2_500; // the drawn cards face up, before the seats change and the deal
const BOT_DRAW_TO_DISCARD_MS = 2_000; // a bot keeps the card it drew at least this long before throwing
const READY_WAIT_MS = 30_000; // the round's results: who hasn't pressed "ready" by then is ready anyway
const NEXT_ROUND_MS = 5_000; // everyone's ready: the next deal comes after this
const RECONNECT_SECONDS = 600;
const CLOSE_AFTER_GAME_MS = 60_000;

export const thresholdFor = (players: number) => (players >= 5 ? 71 : players === 4 ? 91 : 101);

export class RummyRoom extends Room<{ metadata: Meta }> {
  static botSpeed = 1; // tests: bots think faster
  maxClients = MAX_SEATS;
  botFailures = 0; // tests: bot moves the room refused

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private maxPlayers = 4;
  private turnSeconds = 60;
  private losingScore = 2000;
  private openPoints = 0;
  private rules: Rules = { ...DEFAULT_RULES };
  private lastOpening = 0; // this round's highest opening (each opening must beat it, by the rules)
  private teams = false; // 2 vs 2: seats 0 & 2 against 1 & 3 (partners face to face)
  private teamScores = [0, 0];
  private ready = new Set<string>(); // between rounds: who pressed "ready" (bots always are)
  private nextRoundAt = 0; // everyone's ready: when the next round is dealt
  /** The seat draw: a straight face down in the middle (10 J Q K A at five), each player picks one. */
  private seating: { cards: number[]; picks: Map<string, number>; shown: boolean } | null = null;
  private discardDown = false; // the round's last card went face down (a plain rummy)
  private seats: Seat[] = []; // seat order = turn order
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>(); // account uids invited by someone at the table
  private hands = new Map<string, number[]>();
  private opened = new Set<string>(); // laid down this round
  private staged = new Map<string, number[][]>(); // melds being put together for the next lay-down (still in the hand)
  private deck: number[] = [];
  private discard: number[] = [];
  private melds: TableMeld[] = [];
  private meldSeq = 0;
  private botSeq = 0;
  private round = 0;
  private starter = -1; // seat index that started the round
  private turn = ""; // whose turn
  private stage: "draw" | "play" = "draw";
  private taken: number | null = null; // the discard he took: nothing goes on the table without it
  private drawn: number | null = null;
  private turnEndsAt = 0;
  private lastRound: RoundResult | null = null;
  private waited = new Map<string, number>(); // hard bots: turns spent waiting for a joker finish
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("rummy_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on<{ level: string }>("add_bot", (c, m) => this.handleAddBot(c, m.level));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on("draw", (c) => this.handleDraw(c));
    on("take", (c) => this.handleTake(c));
    on("untake", (c) => this.handleUntake(c));
    on<{ cards: number[] }>("stage", (c, m) => this.handleStage(c, m.cards));
    on<{ index: number }>("unstage", (c, m) => this.handleUnstage(c, m.index));
    on("lay", (c) => this.handleLay(c));
    on<{ meldId: number; cards: number[] }>("add", (c, m) => this.handleAdd(c, m.meldId, m.cards));
    on<{ meldId: number; card?: number; cards?: number[] }>("swap", (c, m) =>
      this.handleSwap(c, m.meldId, m.cards ?? (m.card === undefined ? [] : [m.card])),
    );
    on<{ card: number; faceUp?: boolean }>("discard", (c, m) => this.handleDiscard(c, m.card, m.faceUp));
    on<{ id: string }>("partner", (c, m) => this.handlePartner(c, m.id));
    on("ready", (c) => this.handleReady(c.sessionId));
    on<{ index: number }>("pick", (c, m) => this.handlePick(c.sessionId, Number(m.index)));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    // Someone at the table invited a friend (the invite itself goes through the app's chat): let him in.
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (this.seat(client.sessionId) && typeof msg?.uid === "string") this.invited.add(msg.uid);
    });
    this.updateListing();
  }

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
    await this.checkRoomType(account);
    return { account };
  }

  /** Friends rooms: invited players, or friends of someone at the table. Private: invited only. */
  private async checkRoomType(account: Account | null) {
    if (this.roomType === "public" || this.seats.every((s) => s.bot)) return; // the host creating it
    if (account && this.invited.has(account.uid)) return;
    const uids = [...new Set(this.members.values())];
    if (this.roomType === "friends" && account && (await isFriendOfAny(account.uid, uids))) return;
    throw new ServerError(4410, this.roomType === "private" ? "private" : "friends");
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    const account: Account | null = client.auth?.account ?? null;
    const playerId = account?.uid ?? String(options.playerId ?? client.sessionId);
    // Same account (or device) already seated: a join its app gave up on. That seat goes.
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
      score: 0,
      bot: null,
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
    if (SCORE_OPTIONS.includes(Number(s.losingScore))) this.losingScore = Number(s.losingScore);
    if (OPEN_OPTIONS.includes(Number(s.openPoints))) this.openPoints = Number(s.openPoints);
    for (const [key, value] of Object.entries(s.rules ?? {})) {
      if (key in DEFAULT_RULES && typeof value === "boolean") this.rules[key as keyof Rules] = value;
    }
    // 2 vs 2 needs exactly four seats.
    if (typeof s.teams === "boolean") this.teams = s.teams && this.seats.length <= 4;
    if (this.teams) this.maxPlayers = 4;
    this.updateListing();
  }

  /**
   * 2 vs 2: the host picks his partner. Seats are reordered host, opponent, partner, opponent, so
   * partners sit face to face and turns alternate between the teams.
   */
  private handlePartner(client: Client, partnerId: string) {
    const host = client.sessionId;
    if (this.phase !== "lobby" || host !== this.hostId || !this.teams || host === partnerId) return;
    const partner = this.seat(partnerId);
    if (!partner) return;
    const others = this.seats.filter((x) => x.id !== host && x.id !== partnerId);
    this.seats = [this.seat(host)!, others[0], partner, others[1]].filter((x) => x !== undefined);
  }

  private teamOf(id: string) {
    return this.seats.findIndex((x) => x.id === id) % 2;
  }

  private partnerOf(id: string): string | null {
    if (!this.teams) return null;
    const i = this.seats.findIndex((x) => x.id === id);
    return this.seats[(i + 2) % 4]?.id ?? null;
  }

  /** He may add to melds and swap jokers: he opened, or (2 vs 2) his partner did. */
  private teamOpened(id: string) {
    const partner = this.partnerOf(id);
    return this.opened.has(id) || (partner !== null && this.opened.has(partner));
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
      frame: 0,
      connected: true,
      score: 0,
      bot: BOT_LEVELS.includes(level as BotLevel) ? (level as BotLevel) : "normal",
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
    if (this.seats.length < 2) return "not_enough_players";
    if (this.teams && this.seats.length !== 4) return "teams_need_four";
    this.lock();
    if (this.teams) this.deal();
    else this.startSeating();
  }

  /**
   * Before the first deal, the seats are drawn: the top of a straight (10 J Q K A at five players,
   * J Q K A at four, Q K A at three, K A at two) lies face down in the middle and everyone picks one —
   * bots at once, anyone still thinking after 10 s gets a random one. Then the seats follow the cards:
   * the A sits first and plays first, then the K, the Q…
   */
  private startSeating() {
    const ranks = [10, 11, 12, 13, 1].slice(5 - this.seats.length);
    const cards = shuffled()
      .filter((c) => c < 52 && ranks.includes((c % 13) + 1))
      .filter((c, i, all) => all.findIndex((x) => x % 13 === c % 13) === i); // one of each rank, any suit
    this.seating = { cards, picks: new Map(), shown: false };
    this.phase = "seating";
    this.turnEndsAt = Date.now() + PICK_MS;
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => (this.showPicks(), this.sync()), PICK_MS);
    for (const bot of this.seats.filter((x) => x.bot)) {
      this.clock.setTimeout(() => {
        const free = this.freePicks();
        if (free.length > 0) this.handlePick(bot.id, free[Math.floor(Math.random() * free.length)]);
        this.sync();
      }, (600 + Math.random() * 1600) * RummyRoom.botSpeed);
    }
  }

  private freePicks() {
    const taken = new Set(this.seating?.picks.values());
    return (this.seating?.cards ?? []).map((_, i) => i).filter((i) => !taken.has(i));
  }

  private handlePick(id: string, index: number) {
    const seating = this.seating;
    if (this.phase !== "seating" || !seating || seating.shown || seating.picks.has(id) || !this.seat(id)) return;
    if (!this.freePicks().includes(index)) return;
    seating.picks.set(id, index);
    if (seating.picks.size === this.seats.length) this.showPicks();
  }

  /** Everyone has a card (random for the late): all face up, then the seats change and the deal starts. */
  private showPicks() {
    const seating = this.seating;
    if (!seating || seating.shown) return;
    this.timer?.clear();
    for (const x of this.seats) {
      if (!seating.picks.has(x.id)) seating.picks.set(x.id, this.freePicks()[0]);
    }
    seating.shown = true;
    this.turnEndsAt = 0;
    this.timer = this.clock.setTimeout(() => {
      const value = (id: string) => {
        const rank = (seating.cards[seating.picks.get(id)!] % 13) + 1;
        return rank === 1 ? 14 : rank;
      };
      this.seats.sort((a, b) => value(b.id) - value(a.id)); // the A first: he plays first
      this.seating = null;
      this.deal();
      this.sync();
    }, PICKS_SHOWN_MS);
  }

  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.seats.splice(index, 1);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot)?.id ?? "";
  }

  /** Gone mid-game: a normal bot takes over his seat, his cards and his score. */
  private becomeBot(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.bot) return;
    seat.bot = "normal";
    seat.connected = true;
    if (this.phase === "round_end") this.handleReady(id);
    if (this.turn === id && this.phase === "playing") {
      this.staged.delete(id);
      this.botTurn(id);
    }
  }

  // ---- the round ----

  /** The points an opening needs now: the table's threshold, or beating the round's best opening. */
  private threshold() {
    const base = this.base();
    return this.rules.raiseOpening && this.lastOpening >= base ? this.lastOpening + 1 : base;
  }

  /** The table's starting minimum: what an opening always needs without jokers. */
  private base() {
    return this.openPoints || thresholdFor(this.seats.length);
  }

  private deal() {
    this.round++;
    this.phase = "playing";
    this.deck = shuffled();
    this.discard = [];
    this.melds = [];
    this.opened.clear();
    this.staged.clear();
    this.waited.clear();
    this.lastOpening = 0;
    this.ready.clear();
    this.nextRoundAt = 0;
    this.discardDown = false;
    this.starter = (this.starter + 1) % this.seats.length;
    // One card at a time around the table, from the first player (who gets the 15th).
    const order = [...this.seats.slice(this.starter), ...this.seats.slice(0, this.starter)];
    for (const s of this.seats) this.hands.set(s.id, []);
    for (let i = 0; i < HAND; i++) for (const s of order) this.hands.get(s.id)!.push(this.deck.pop()!);
    const first = order[0].id;
    this.hands.get(first)!.push(this.deck.pop()!);
    this.broadcast("rummy_fx", { type: "deal", order: order.map((s) => s.id) });
    this.startTurn(first, "play", DEAL_MS);
  }

  private startTurn(id: string, stage: "draw" | "play", extraMs = 0) {
    this.turn = id;
    this.stage = stage;
    this.taken = null;
    this.drawn = null;
    this.staged.delete(id);
    this.turnEndsAt = Date.now() + extraMs + this.turnSeconds * 1000;
    this.timer?.clear();
    this.botTimer?.clear();
    this.timer = this.clock.setTimeout(() => this.timeOut(), extraMs + this.turnSeconds * 1000);
    if (this.seat(id)?.bot) this.botTurn(id, extraMs);
  }

  /** Out of time: back to a plain turn — draw if he hasn't, then throw what he drew. */
  private timeOut() {
    const id = this.turn;
    const hand = this.hands.get(id);
    if (!hand || this.phase !== "playing") return;
    this.staged.delete(id);
    if (this.taken !== null && hand.includes(this.taken)) this.handleUntake(this.clientOf(id));
    if (this.stage === "draw") this.drawCard(id);
    const card = this.drawn !== null && hand.includes(this.drawn) ? this.drawn : hand[hand.length - 1];
    this.throwCard(id, card);
    this.sync();
  }

  private clientOf(id: string) {
    return { sessionId: id } as Client;
  }

  private actor(client: Client, stage: "draw" | "play"): string | null {
    return this.phase === "playing" && client.sessionId === this.turn && this.stage === stage ? client.sessionId : null;
  }

  /**
   * Drawing from an empty deck means "reshuffle": the deck ran out, and the next player chose not to
   * take the discard — every discard (the top one too) becomes the new deck.
   */
  private drawCard(id: string) {
    if (this.deck.length === 0) {
      this.retireFullSets(id); // complete sets on the table go back into the deck too
      this.deck = shuffled().filter((c) => this.discard.includes(c));
      this.broadcast("rummy_fx", { type: "refill", count: this.discard.length });
      this.discard = [];
    }
    const card = this.deck.pop();
    if (card === undefined) return; // ponytail: 108 cards never run out with 5 players; ignore
    this.hands.get(id)!.push(card);
    this.drawn = card;
    this.stage = "play";
    this.broadcast("rummy_fx", { type: "draw", who: id, from: "deck" });
  }

  private handleDraw(client: Client) {
    const id = this.actor(client, "draw");
    if (id) this.drawCard(id);
  }

  private handleTake(client: Client) {
    const id = this.actor(client, "draw");
    if (!id || this.discard.length === 0) return;
    if (this.rules.noDiscardOnLast && this.hands.get(id)!.length === 1) return "last_card_take";
    this.taken = this.discard.pop()!;
    this.hands.get(id)!.push(this.taken);
    this.stage = "play";
    this.broadcast("rummy_fx", { type: "draw", who: id, from: "discard", card: this.taken });
  }

  private handleUntake(client: Client) {
    const id = this.actor(client, "play");
    const hand = id && this.hands.get(id);
    if (!hand || this.taken === null || !hand.includes(this.taken)) return;
    this.staged.set(id, (this.staged.get(id) ?? []).filter((m) => !m.includes(this.taken!)));
    hand.splice(hand.indexOf(this.taken), 1);
    this.discard.push(this.taken);
    this.broadcast("rummy_fx", { type: "discard", who: id, card: this.taken });
    this.taken = null;
    this.stage = "draw";
  }

  /** Cards in his hand that aren't already staged; null if any isn't. */
  private free(id: string, cards: unknown): number[] | null {
    if (!Array.isArray(cards) || cards.length === 0) return null;
    const hand = this.hands.get(id) ?? [];
    const staged = (this.staged.get(id) ?? []).flat();
    const picked = cards.map(Number);
    if (new Set(picked).size !== picked.length) return null;
    return picked.every((c) => hand.includes(c) && !staged.includes(c)) ? picked : null;
  }

  /** A player must always keep one card to throw at the end of his turn. */
  private keepsOne(id: string, using: number) {
    return this.hands.get(id)!.length - using >= 1;
  }

  private handleStage(client: Client, cards: number[]) {
    const id = this.actor(client, "play");
    if (!id) return;
    const picked = this.free(id, cards);
    if (!picked) return "bad_cards";
    const meld = meldOf(picked);
    if (!meld) return "not_a_meld";
    const broken = layError(meld, this.rules);
    if (broken) return broken;
    const staged = this.staged.get(id) ?? [];
    if (!this.keepsOne(id, staged.flat().length + picked.length)) return "keep_one";
    this.staged.set(id, [...staged, meld.cards]);
  }

  private handleUnstage(client: Client, index: number) {
    const id = this.phase === "playing" && client.sessionId === this.turn ? client.sessionId : null;
    if (id) this.staged.get(id)?.splice(Number(index), 1);
  }

  /**
   * After taking the discard, his cards go on the table only with it — or with his own copy of it
   * (two decks: his 5♣ stands for the 5♣ he took, which can stay in his hand).
   */
  private takenUsed(cards: number[]) {
    const t = this.taken;
    return t === null || cards.some((c) => c === t || (!isJoker(c) && !isJoker(t) && c % 52 === t % 52));
  }

  /** The exception: a discarded joker taken to finish — every other card goes down, the joker is his last throw. */
  private jokerFinish(id: string, using: number) {
    return this.taken !== null && isJoker(this.taken) && this.hands.get(id)!.length - using === 1;
  }

  private handleLay(client: Client) {
    const id = this.actor(client, "play");
    const staged = id ? this.staged.get(id) ?? [] : [];
    if (!id || staged.length === 0) return;
    if (!this.takenUsed(staged.flat()) && !this.jokerFinish(id, staged.flat().length)) return "use_taken";
    const partner = this.partnerOf(id);
    if (!this.opened.has(id) && partner !== null && this.opened.has(partner)) {
      // 2 vs 2: my partner opened, so I lay without points — under the team rules.
      const broken = teamLayError(staged.map((c) => meldOf(c)!), this.rules);
      if (broken) return broken;
      this.opened.add(id);
    } else if (!this.opened.has(id)) {
      // The opening: enough points (by default without the jokers' melds), a real run, maybe a taken card.
      const melds = staged.map((c) => meldOf(c)!);
      if (this.rules.openWithDiscard && (this.taken === null || !this.takenUsed(staged.flat()))) return "open_with_discard";
      const broken = openingError(melds, this.base(), this.threshold(), this.rules);
      if (broken) return broken;
      this.opened.add(id);
      // The next opening must beat everything laid here, joker melds included (a joker worth its card).
      this.lastOpening = Math.max(this.lastOpening, melds.reduce((n, m) => n + m.full, 0));
    }
    const hand = this.hands.get(id)!;
    const laid: number[] = [];
    for (const cards of staged) {
      const meld = meldOf(cards)!;
      this.melds.push({ id: ++this.meldSeq, owner: id, kind: meld.kind, cards: meld.cards });
      laid.push(this.meldSeq);
      for (const c of cards) hand.splice(hand.indexOf(c), 1);
    }
    this.broadcast("rummy_fx", { type: "lay", who: id, melds: laid });
    if (this.takenUsed(staged.flat())) this.taken = null;
    this.staged.delete(id);
  }

  private handleAdd(client: Client, meldId: number, cards: number[]) {
    const id = this.actor(client, "play");
    if (!id) return;
    if (!this.teamOpened(id)) return "not_opened";
    const meld = this.melds.find((m) => m.id === Number(meldId));
    const picked = this.free(id, cards);
    if (!meld || !picked) return "bad_cards";
    if (!this.rules.addToOthers && meld.owner !== id && meld.owner !== this.partnerOf(id)) return "not_yours";
    const grown = meldOf([...meld.cards, ...picked]);
    if (!grown || grown.kind !== meld.kind) return "not_a_meld";
    if (this.rules.oneJoker && grown.cards.filter(isJoker).length > 1) return "two_jokers";
    if (!this.takenUsed(picked) && !this.jokerFinish(id, picked.length)) return "use_taken";
    if (!this.keepsOne(id, (this.staged.get(id) ?? []).flat().length + picked.length)) return "keep_one";
    meld.cards = grown.cards;
    const hand = this.hands.get(id)!;
    for (const c of picked) hand.splice(hand.indexOf(c), 1);
    this.broadcast("rummy_fx", { type: "add", who: id, meldId: meld.id, cards: picked });
    if (this.takenUsed(picked)) this.taken = null;
  }

  /**
   * Taking a joker from the table. In a run, the real card it stands for takes its place. In a set
   * (9 9 joker), every missing card is needed — the two other 9s — and the set becomes complete.
   */
  private handleSwap(client: Client, meldId: number, cards: number[]) {
    const id = this.actor(client, "play");
    if (!id) return;
    if (!this.teamOpened(id)) return "not_opened";
    if (!this.rules.jokerSwap) return "no_swap";
    const meld = this.melds.find((m) => m.id === Number(meldId));
    const picked = this.free(id, cards);
    if (!meld || !picked) return "bad_cards";
    const index = meld.cards.findIndex(isJoker);
    if (index < 0) return "no_joker_fits";
    if (!this.takenUsed(picked)) return "use_taken";
    const hand = this.hands.get(id)!;
    const joker = meld.cards[index];
    if (meld.kind === "set") {
      const real = meld.cards.filter((c) => !isJoker(c));
      const missing = [0, 1, 2, 3].filter((suit) => !real.some((c) => suitOf(c) === suit));
      const fits =
        picked.length === missing.length &&
        picked.every((c) => !isJoker(c) && rankOf(c) === rankOf(real[0])) &&
        missing.every((suit) => picked.some((c) => suitOf(c) === suit));
      if (!fits) return picked.length < missing.length ? "joker_needs_all" : "no_joker_fits";
      meld.cards = meldOf([...real, ...picked])!.cards;
    } else {
      if (picked.length !== 1 || !jokerFits(meld, index, picked[0])) return "no_joker_fits";
      meld.cards[index] = picked[0];
    }
    for (const c of picked) hand.splice(hand.indexOf(c), 1);
    hand.push(joker);
    this.taken = null;
    this.broadcast("rummy_fx", { type: "add", who: id, meldId: meld.id, cards: picked });
  }

  /** Complete sets (the four suits) have nothing left to take: at the reshuffle they leave the table, into the discards. */
  private retireFullSets(by: string) {
    for (const meld of [...this.melds]) {
      if (meld.kind !== "set" || meld.cards.length < 4 || meld.cards.some(isJoker)) continue;
      this.melds.splice(this.melds.indexOf(meld), 1);
      this.discard.unshift(...meld.cards); // under the pile: the top card doesn't change
      this.broadcast("rummy_fx", { type: "retire", who: by, meldId: meld.id, cards: meld.cards });
    }
  }

  private handleDiscard(client: Client, card: number, faceUp?: boolean) {
    const id = this.actor(client, "play");
    if (!id) return;
    const hand = this.hands.get(id)!;
    if (this.taken !== null && !(isJoker(this.taken) && hand.length === 1)) return "use_taken";
    if (!hand.includes(Number(card))) return "bad_cards";
    this.throwCard(id, Number(card), faceUp !== false);
  }

  /**
   * The last card (the rummy) goes face down — unless it's a joker the player shows face up: a joker
   * rummy, penalties doubled. Laid face down, a joker counts as a plain rummy.
   */
  private throwCard(id: string, card: number, faceUp = true) {
    const hand = this.hands.get(id)!;
    hand.splice(hand.indexOf(card), 1);
    this.staged.delete(id);
    this.discard.push(card);
    const last = hand.length === 0;
    const jokerRummy = last && isJoker(card) && faceUp;
    this.discardDown = last && !jokerRummy;
    this.broadcast("rummy_fx", { type: "discard", who: id, card, faceDown: this.discardDown });
    if (last) return this.endRound(id, jokerRummy);
    const next = this.seats[(this.seats.findIndex((s) => s.id === id) + 1) % this.seats.length];
    this.startTurn(next.id, "draw");
  }

  private endRound(winner: string, joker: boolean) {
    this.timer?.clear();
    this.botTimer?.clear();
    const penalties: Record<string, number> = {};
    const winners = this.teams ? this.seats.filter((x) => this.teamOf(x.id) === this.teamOf(winner)) : [this.seat(winner)];
    for (const s of this.seats) {
      if (winners.includes(s)) continue; // 2 vs 2: the winner's partner takes nothing either
      const base = this.opened.has(s.id) ? PER_CARD * this.hands.get(s.id)!.length : NEVER_OPENED;
      penalties[s.id] = joker && this.rules.jokerDouble ? base * 2 : base;
      if (this.teams) this.teamScores[this.teamOf(s.id)] += penalties[s.id];
      else s.score += penalties[s.id];
    }
    if (this.teams) for (const s of this.seats) s.score = this.teamScores[this.teamOf(s.id)]; // one score per team
    this.lastRound = { winner, joker, penalties };
    this.turn = "";
    if (this.seats.some((s) => s.score >= this.losingScore)) return this.endGame();
    // Results: everyone presses "ready" (bots are), or is ready anyway after a while.
    this.phase = "round_end";
    this.ready = new Set(this.seats.filter((x) => x.bot).map((x) => x.id));
    this.nextRoundAt = 0;
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

  /** Everyone's ready: the next round in 5 seconds. */
  private allReady() {
    if (this.nextRoundAt || this.seats.some((x) => !this.ready.has(x.id))) return;
    this.timer?.clear();
    this.nextRoundAt = this.turnEndsAt = Date.now() + NEXT_ROUND_MS;
    this.timer = this.clock.setTimeout(() => (this.deal(), this.sync()), NEXT_ROUND_MS);
  }

  private endGame() {
    this.timer?.clear();
    this.botTimer?.clear();
    this.phase = "gameover";
    this.turn = "";
    this.turnEndsAt = 0;
    this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
  }

  // ---- bots ----

  private botView(id: string): BotView {
    const seat = this.seat(id)!;
    const hand = this.hands.get(id)!;
    const jokersSeen = [...this.melds.flatMap((m) => m.cards), ...this.discard, ...hand].filter(isJoker).length;
    const others = this.seats.filter((s) => s.id !== id);
    const next = this.seats[(this.seats.indexOf(seat) + 1) % this.seats.length];
    return {
      level: seat.bot ?? "normal",
      hand: [...hand],
      me: id,
      partner: this.partnerOf(id),
      opened: this.opened.has(id),
      partnerOpened: this.teamOpened(id) && !this.opened.has(id),
      threshold: this.threshold(),
      base: this.base(),
      rules: this.rules,
      melds: this.melds,
      taken: this.taken,
      canWait:
        jokersSeen < 4 &&
        this.deck.length > 8 &&
        (this.waited.get(id) ?? 0) < 3 &&
        others.every((s) => (this.hands.get(s.id)?.length ?? 0) >= 6),
      nextOpened: this.opened.has(next.id),
    };
  }

  /** A bot's turn, one move at a time like a person: think, draw, lay down, throw. */
  private botTurn(id: string, delayMs = 0) {
    const steps: (() => string | void)[] = [];
    const me = this.clientOf(id);
    const think = () => (700 + Math.random() * 900) * RummyRoom.botSpeed;
    let pause = 0; // extra wait after a move, for its animation
    let drewAt = 0;
    let throwIt = () => undefined as string | void; // set once the plan is known
    const run = (ms: number) => {
      this.botTimer = this.clock.setTimeout(() => {
        if (this.turn !== id || this.phase !== "playing") return;
        const step = steps.shift();
        if (!step) return;
        if (step()) {
          this.botFailures++;
          return this.timeOut(); // a move the room refused: undo the half moves and throw a card
        }
        this.sync();
        if (steps.length > 0) {
          let wait = 450 + Math.random() * 350 + pause;
          // It holds the card it drew a moment before throwing one.
          if (steps[0] === throwIt) wait = Math.max(wait, BOT_DRAW_TO_DISCARD_MS - (Date.now() - drewAt));
          run(wait * RummyRoom.botSpeed);
        }
        pause = 0;
      }, ms);
    };
    steps.push(() => {
      if (this.stage === "draw") {
        const top = this.discard[this.discard.length - 1];
        top !== undefined && wantsDiscard(this.botView(id), top) ? this.handleTake(me) : this.handleDraw(me);
      }
      drewAt = Date.now();
      const plan = planTurn(this.botView(id));
      if (!plan) return "no_plan";
      throwIt = () => this.handleDiscard(me, plan.discard, true); // a joker rummy is shown face up
      if (plan.waiting) this.waited.set(id, (this.waited.get(id) ?? 0) + 1);
      for (const s of plan.swaps) steps.push(() => this.handleSwap(me, s.meldId, s.cards));
      for (const cards of plan.lay) steps.push(() => this.handleStage(me, cards));
      if (plan.lay.length > 0) {
        steps.push(() => {
          pause = plan.lay.length * LAY_MS; // the apps show the melds coming down one by one
          return this.handleLay(me);
        });
      }
      for (const a of plan.adds) steps.push(() => this.handleAdd(me, a.meldId, a.cards));
      steps.push(throwIt);
    });
    run(delayMs * RummyRoom.botSpeed + think());
  }

  // ---- sync ----

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
        maxPlayers: this.maxPlayers,
        spectators: 0,
      },
    });
  }

  /** Everyone's view: the table, the scores, and his own hand. */
  private sync() {
    const table = {
      phase: this.phase,
      seating: this.seating && {
        count: this.seating.cards.length,
        picks: Object.fromEntries(this.seating.picks),
        cards: this.seating.shown ? this.seating.cards : [],
      },
      hostId: this.hostId,
      roomType: this.roomType,
      maxPlayers: this.maxPlayers,
      turnSeconds: this.turnSeconds,
      losingScore: this.losingScore,
      openPoints: this.openPoints,
      rules: this.rules,
      teams: this.teams,
      ready: [...this.ready],
      nextRoundAt: this.nextRoundAt,
      discardDown: this.discardDown,
      round: this.round,
      threshold: this.threshold(),
      base: this.base(),
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, connected: s.connected, score: s.score, bot: s.bot ?? "",
        team: this.teams ? this.teamOf(s.id) : -1,
        opened: this.opened.has(s.id), cards: this.hands.get(s.id)?.length ?? 0,
      })),
      turn: this.turn,
      stage: this.stage,
      taken: this.taken ?? -1,
      turnEndsAt: this.turnEndsAt,
      deck: this.deck.length,
      discardTail: this.discard.slice(-6),
      discardCount: this.discard.length,
      melds: this.melds,
      lastRound: this.lastRound,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const id = client.sessionId;
      const staged = this.staged.get(id) ?? [];
      client.send("rummy", {
        ...table,
        me: id,
        hand: (this.hands.get(id) ?? []).filter((c) => !staged.flat().includes(c)),
        staged: staged.map((cards) => {
          const meld = meldOf(cards)!;
          return { cards, points: meld.points, full: meld.full, joker: cards.some(isJoker), run: meld.kind === "run" };
        }),
      });
    }
  }
}
