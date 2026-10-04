import { Room, Client, ServerError } from "colyseus";
import { accountFor, firebaseEnabled, setRoom, type Account } from "../firebase.js";
import { isJoker, jokerFits, meldOf, shuffled, type MeldKind } from "../rummy.js";

/**
 * Algerian rummy, 2–5 players, 14 cards each (the round's first player gets 15 and starts by
 * discarding). A turn: draw from the deck — or take the top discard, only to lay it down this
 * turn — then lay down / add to melds, then discard one card. The first lay-down must reach the
 * table's threshold (101 for 2–3 players, 91 for 4, 71 for 5) counting only melds without a joker.
 * The first player to get rid of every card wins the round: the others take 10 points per card left,
 * 200 if they never laid down, doubled when the winner's last card is a joker. At 2000 the game ends.
 *
 * No schema: each player gets his own "rummy" message (the table, plus his hand) after every change.
 */
type Meta = { host: string; roomType: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type JoinOptions = { name?: string; playerId?: string; idToken?: string; maxPlayers?: number; turnSeconds?: number };
type Seat = { id: string; playerId: string; name: string; uid: string; avatar: number; connected: boolean; score: number };
type TableMeld = { id: number; owner: string; kind: MeldKind; cards: number[] };
type Phase = "lobby" | "playing" | "round_end" | "gameover";
type RoundResult = { winner: string; joker: boolean; penalties: Record<string, number> };

const MAX_SEATS = 5;
const TURN_OPTIONS = [30, 45, 60, 90];
const HAND = 14;
const LOSING_SCORE = 2000;
const NEVER_OPENED = 200, PER_CARD = 10;
const ROUND_PAUSE_MS = 10_000; // the round's results, before the next deal
const RECONNECT_SECONDS = 600;
const CLOSE_AFTER_GAME_MS = 60_000;

export const thresholdFor = (players: number) => (players >= 5 ? 71 : players === 4 ? 91 : 101);

export class RummyRoom extends Room<{ metadata: Meta }> {
  maxClients = MAX_SEATS;

  private phase: Phase = "lobby";
  private hostId = "";
  private maxPlayers = 4;
  private turnSeconds = 60;
  private seats: Seat[] = []; // seat order
  private hands = new Map<string, number[]>();
  private opened = new Set<string>(); // laid down this round
  private staged = new Map<string, number[][]>(); // melds being put together for the next lay-down (still in the hand)
  private deck: number[] = [];
  private discard: number[] = [];
  private melds: TableMeld[] = [];
  private meldSeq = 0;
  private round = 0;
  private starter = -1; // seat index that started the round
  private turn = ""; // whose turn
  private stage: "draw" | "play" = "draw";
  private taken: number | null = null; // the discard he took: nothing goes on the table without it
  private drawn: number | null = null;
  private turnEndsAt = 0;
  private lastRound: RoundResult | null = null;
  private timer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("rummy_error", { code: error });
        this.sync();
      });
    on<JoinOptions>("settings", (c, m) => {
      if (this.phase === "lobby" && c.sessionId === this.hostId) this.applySettings(m);
    });
    on("start_game", (c) => this.handleStart(c));
    on("draw", (c) => this.handleDraw(c));
    on("take", (c) => this.handleTake(c));
    on("untake", (c) => this.handleUntake(c));
    on<{ cards: number[] }>("stage", (c, m) => this.handleStage(c, m.cards));
    on<{ index: number }>("unstage", (c, m) => this.handleUnstage(c, m.index));
    on("lay", (c) => this.handleLay(c));
    on<{ meldId: number; cards: number[] }>("add", (c, m) => this.handleAdd(c, m.meldId, m.cards));
    on<{ meldId: number; card: number }>("swap", (c, m) => this.handleSwap(c, m.meldId, m.card));
    on<{ card: number }>("discard", (c, m) => this.handleDiscard(c, m.card));
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
    return { account };
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
      avatar: account?.avatar ?? 0,
      connected: true,
      score: 0,
    });
    if (account) setRoom(account.uid, this.roomId).catch(() => {});
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
    const seat = this.seat(client.sessionId);
    if (seat?.uid) setRoom(seat.uid, "", this.roomId).catch(() => {});
    this.removeSeat(client.sessionId);
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.timer?.clear();
  }

  // ---- lobby ----

  private applySettings(s: JoinOptions) {
    const n = Math.floor(Number(s.maxPlayers));
    if (n >= 2 && n <= MAX_SEATS) this.maxPlayers = Math.max(n, this.seats.length);
    if (TURN_OPTIONS.includes(Number(s.turnSeconds))) this.turnSeconds = Number(s.turnSeconds);
    this.updateListing();
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || client.sessionId !== this.hostId) return;
    if (this.seats.length < 2) return "not_enough_players";
    this.lock();
    this.deal();
  }

  /** A player gone for good: out of the game, his cards out of play. */
  private removeSeat(id: string) {
    const index = this.seats.findIndex((s) => s.id === id);
    if (index < 0) return;
    const wasTurn = this.turn === id;
    this.seats.splice(index, 1);
    this.hands.delete(id);
    this.staged.delete(id);
    if (this.starter >= index) this.starter--;
    if (this.hostId === id) this.hostId = this.seats[0]?.id ?? "";
    if (this.phase === "lobby" || this.phase === "gameover") return;
    if (this.seats.length < 2) return this.endGame();
    if (wasTurn && this.phase === "playing") this.startTurn(this.seats[index % this.seats.length].id, "draw");
  }

  // ---- the round ----

  private deal() {
    this.round++;
    this.phase = "playing";
    this.deck = shuffled();
    this.discard = [];
    this.melds = [];
    this.opened.clear();
    this.staged.clear();
    this.starter = (this.starter + 1) % this.seats.length;
    for (const s of this.seats) this.hands.set(s.id, this.deck.splice(0, HAND));
    const first = this.seats[this.starter].id;
    this.hands.get(first)!.push(this.deck.pop()!); // 15 cards: he starts by discarding
    this.startTurn(first, "play");
  }

  private startTurn(id: string, stage: "draw" | "play") {
    this.turn = id;
    this.stage = stage;
    this.taken = null;
    this.drawn = null;
    this.staged.delete(id);
    this.turnEndsAt = Date.now() + this.turnSeconds * 1000;
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => this.timeOut(), this.turnSeconds * 1000);
  }

  /** Out of time: back to a plain turn — draw if he hasn't, then throw what he drew. */
  private timeOut() {
    const id = this.turn;
    const hand = this.hands.get(id);
    if (!hand) return;
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

  private drawCard(id: string) {
    if (this.deck.length === 0) {
      // Every discard goes back into the deck (the top one too: nobody took it to lay it down).
      this.deck = this.discard.sort(() => Math.random() - 0.5);
      this.discard = [];
    }
    const card = this.deck.pop();
    if (card === undefined) return; // ponytail: 108 cards never run out with 5 players; ignore
    this.hands.get(id)!.push(card);
    this.drawn = card;
    this.stage = "play";
  }

  private handleDraw(client: Client) {
    const id = this.actor(client, "draw");
    if (id) this.drawCard(id);
  }

  private handleTake(client: Client) {
    const id = this.actor(client, "draw");
    if (!id || this.discard.length === 0) return;
    this.taken = this.discard.pop()!;
    this.hands.get(id)!.push(this.taken);
    this.stage = "play";
  }

  private handleUntake(client: Client) {
    const id = this.actor(client, "play");
    const hand = id && this.hands.get(id);
    if (!hand || this.taken === null || !hand.includes(this.taken)) return;
    this.staged.set(id, (this.staged.get(id) ?? []).filter((m) => !m.includes(this.taken!)));
    hand.splice(hand.indexOf(this.taken), 1);
    this.discard.push(this.taken);
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
    const staged = this.staged.get(id) ?? [];
    if (!this.keepsOne(id, staged.flat().length + picked.length)) return "keep_one";
    this.staged.set(id, [...staged, meld.cards]);
  }

  private handleUnstage(client: Client, index: number) {
    const id = this.actor(client, "play");
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
    if (!this.opened.has(id)) {
      // The opening: melds without a joker must reach the threshold on their own.
      const points = staged.map((c) => meldOf(c)!).filter((m) => !m.cards.some(isJoker)).reduce((n, m) => n + m.points, 0);
      if (points < thresholdFor(this.seats.length)) return "below_threshold";
      this.opened.add(id);
    }
    const hand = this.hands.get(id)!;
    for (const cards of staged) {
      const meld = meldOf(cards)!;
      this.melds.push({ id: ++this.meldSeq, owner: id, kind: meld.kind, cards: meld.cards });
      for (const c of cards) hand.splice(hand.indexOf(c), 1);
    }
    if (this.takenUsed(staged.flat())) this.taken = null;
    this.staged.delete(id);
  }

  private handleAdd(client: Client, meldId: number, cards: number[]) {
    const id = this.actor(client, "play");
    if (!id) return;
    if (!this.opened.has(id)) return "not_opened";
    const meld = this.melds.find((m) => m.id === Number(meldId));
    const picked = this.free(id, cards);
    if (!meld || !picked) return "bad_cards";
    const grown = meldOf([...meld.cards, ...picked]);
    if (!grown || grown.kind !== meld.kind) return "not_a_meld";
    if (!this.takenUsed(picked) && !this.jokerFinish(id, picked.length)) return "use_taken";
    if (!this.keepsOne(id, (this.staged.get(id) ?? []).flat().length + picked.length)) return "keep_one";
    meld.cards = grown.cards;
    const hand = this.hands.get(id)!;
    for (const c of picked) hand.splice(hand.indexOf(c), 1);
    if (this.takenUsed(picked)) this.taken = null;
  }

  /** The real card a joker on the table stands for takes its place; the joker goes to his hand. */
  private handleSwap(client: Client, meldId: number, card: number) {
    const id = this.actor(client, "play");
    if (!id) return;
    if (!this.opened.has(id)) return "not_opened";
    const meld = this.melds.find((m) => m.id === Number(meldId));
    if (!meld || !this.free(id, [card])) return "bad_cards";
    const index = meld.cards.findIndex((_, i) => jokerFits(meld, i, Number(card)));
    if (index < 0) return "no_joker_fits";
    if (!this.takenUsed([Number(card)])) return "use_taken";
    const hand = this.hands.get(id)!;
    hand.splice(hand.indexOf(Number(card)), 1, meld.cards[index]);
    meld.cards[index] = Number(card);
    this.taken = null;
  }

  private handleDiscard(client: Client, card: number) {
    const id = this.actor(client, "play");
    if (!id) return;
    const hand = this.hands.get(id)!;
    if (this.taken !== null && !(isJoker(this.taken) && hand.length === 1)) return "use_taken";
    if (!hand.includes(Number(card))) return "bad_cards";
    this.throwCard(id, Number(card));
  }

  private throwCard(id: string, card: number) {
    const hand = this.hands.get(id)!;
    hand.splice(hand.indexOf(card), 1);
    this.staged.delete(id);
    this.discard.push(card);
    if (hand.length === 0) return this.endRound(id, isJoker(card));
    const next = this.seats[(this.seats.findIndex((s) => s.id === id) + 1) % this.seats.length];
    this.startTurn(next.id, "draw");
  }

  private endRound(winner: string, joker: boolean) {
    this.timer?.clear();
    const penalties: Record<string, number> = {};
    for (const s of this.seats) {
      if (s.id === winner) continue;
      const base = this.opened.has(s.id) ? PER_CARD * this.hands.get(s.id)!.length : NEVER_OPENED;
      penalties[s.id] = joker ? base * 2 : base;
      s.score += penalties[s.id];
    }
    this.lastRound = { winner, joker, penalties };
    this.turn = "";
    if (this.seats.some((s) => s.score >= LOSING_SCORE)) return this.endGame();
    this.phase = "round_end";
    this.turnEndsAt = Date.now() + ROUND_PAUSE_MS;
    this.timer = this.clock.setTimeout(() => (this.deal(), this.sync()), ROUND_PAUSE_MS);
  }

  private endGame() {
    this.timer?.clear();
    this.phase = "gameover";
    this.turn = "";
    this.turnEndsAt = 0;
    this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
  }

  // ---- sync ----

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private updateListing() {
    this.setMatchmaking({
      metadata: {
        host: this.seat(this.hostId)?.name ?? "",
      roomType: "public",
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
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      turnSeconds: this.turnSeconds,
      round: this.round,
      threshold: thresholdFor(this.seats.length),
      losingScore: LOSING_SCORE,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, connected: s.connected, score: s.score,
        opened: this.opened.has(s.id), cards: this.hands.get(s.id)?.length ?? 0,
      })),
      turn: this.turn,
      stage: this.stage,
      taken: this.taken ?? -1,
      turnEndsAt: this.turnEndsAt,
      deck: this.deck.length,
      discardTop: this.discard[this.discard.length - 1] ?? -1,
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
        staged: staged.map((cards) => ({ cards, points: meldOf(cards)!.points, joker: cards.some(isJoker) })),
      });
    }
  }
}
