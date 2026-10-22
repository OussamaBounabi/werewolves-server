import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import {
  botMove, bracket, covers, found, legend, LEVELS, nextSlot, player, randomLegend, randomPlayer, validQuestion, valueOf,
  type Answer, type Match, type Question,
} from "../guess.js";
import { item, itemsOf, MYSTERY_CATEGORIES } from "../mysteryItems.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { Kicks, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";

/**
 * Guess Who, football edition. Each player has a secret footballer; turn by turn they ask about the other's
 * (position, nationality, club, shirt number — a question may cover several at once: "is he from Europe?")
 * or guess who he is. A wrong guess only costs the turn. Each player has his own clock for the round,
 * running on his turn only: out of time, he loses the round. Best of 1, 3 or 5.
 * Trust mode: no questions on screen — they ask out loud, and whoever's footballer is found says so (the
 * other wins the round); one clock for both, and when it runs out the round is played again.
 * 1 vs 1, or a cup of 4, 6 (two byes into the semi-finals) or 8 — chosen in the waiting room: one match at a time,
 * the others waiting (and, a room setting, seeing both secrets). Who leaves loses his match; his next opponent goes
 * through.
 *
 * No schema: everyone gets the "guess" message after every change (the secrets only to who may see them),
 * and "guess_fx" (answers, guesses, round ends) to animate.
 *
 * Mystery Item (MysteryRoom, below) is this game with things instead of footballers: always in trust mode, an item
 * from a category (one chosen, or any: the same for both or each his own), whose category everyone sees.
 */
type Mode = "duel" | "cup";
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; started: boolean;
  players: number; maxPlayers: number; spectators: number; mode: Mode;
};
type Settings = {
  mode?: string; category?: string; same?: boolean; roomType?: string; rounds?: number; random?: boolean; level?: string; trust?: boolean; legends?: boolean; time?: number; cupSize?: number; spectate?: boolean;
};
type JoinOptions = Settings & { admin?: boolean; mode?: string; name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type Seat = { id: string; playerId: string; name: string; uid: string; avatar: number; frame: number; vip?: string; connected: boolean; bot: boolean; quit: boolean };
/** One of the match's two players: a (blue) or b (red). */
type Side = {
  id: string;
  secret: string; // his footballer (Mystery Item: his item)
  cat: string; // Mystery Item: his item's category (everyone sees it)
  answers: Answer[]; // his questions about the other's, answered
  wrong: string[]; // the footballers he guessed wrong
  clockMs: number; // what's left of his time this round
};
type Phase = "lobby" | "bracket" | "pick" | "playing" | "round" | "between" | "gameover";

const ROOM_TYPES = ["public", "friends", "private"];
const ROUNDS = [1, 3, 5];
const CUP_SIZES = [4, 6, 8];
const TIME_MIN = 30, TIME_MAX = 900, TIME_STEP = 30; // seconds per player and round
const PICK_MS = 30_000; // picking one's footballer (random off)
const ANSWER_MS = 1_600; // the answer shows, then the turn passes
const ROUND_END_MS = 5_000; // both footballers revealed
const BRACKET_MS = 6_000; // the cup's draw, and the bracket between matches
const RECONNECT_SECONDS = 60; // a dropped player gone over a minute is out, as if he had left
const CLOSE_AFTER_GAME_MS = 90_000;
const BOT_NAMES = ["Amine", "Yasmine", "Karim", "Lina", "Sofiane", "Nour", "Walid", "Sara", "Riad", "Meriem"];

const MAX_SPECTATORS = 20;

export class GuessRoom extends Room<{ metadata: Meta }> {
  protected game: "guess" | "mystery" = "guess";
  private abandon = new Abandon(this); // nobody left to play: the room closes by itself
  static botSpeed = 1; // tests: bots think faster
  static pace = 1; // tests: every pause shorter

  private mode: Mode = "duel";
  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private rounds = 3;
  private random = true; // the footballers are drawn; off: each player picks his own
  private level = "easy"; // drawn from the giants' clubs (easy), 20 well-known ones (medium), the rest (hard)
  private trust = false;
  private legends = false; // trust mode only: the legends instead of today's footballers
  private category = "all"; // Mystery Item: one category, or all of them…
  private same = true; // …the same one for both players each round, or each his own
  private time = 180;
  private cupSize = 8;
  private spectate = false; // a cup's waiting players see both secrets
  private seats: Seat[] = [];
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private banned = new Map<string, string>(); // a kicked player's id → who kicked him (the host then)
  private spectators = new Map<string, JoinOptions>(); // sessionId → how he came: watching a game, without a seat
  private tableTalk!: TableTalk; // the table's chat and emojis
  private admins = new Set<string>(); // the admin app watching, unseen (its God Eye: every secret footballer)
  private returned = new Map<string, string>(); // a returning player's new connection → the seat he had
  private listedStarted = false; // what the room list was last told
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" }; // …and whose face it shows
  private kicks = new Kicks(this); // who may put whom out of the waiting room (a VIP Pro may choose to stay)
  private looks = new RoomLooks(); // a VIP Pro host's name and style for his room in the lists (kept on his account)
  private get look() {
    return this.looks.of(this.hostId);
  }
  private botSeq = 0;
  private matches: Match[] = []; // a cup's, in playing order (1 vs 1: one)
  private current = -1; // the match being played
  private sides: Side[] = [];
  private firstTurn = 0; // who starts the match's first round (they take turns starting)
  private roundNo = 0;
  private turn = ""; // whose turn ("" while an answer shows, between rounds…)
  private turnStartedAt = 0;
  private endsAt = 0; // picking ends / trust mode's clock
  private roundWinner = -1; // the round just played: 0 a, 1 b, -1 nobody
  private champion = "";
  private timer: { clear(): void } | null = null;
  private botTimer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.maxClients = Math.max(...CUP_SIZES) + MAX_SPECTATORS; // the seats are counted in onAuth (the mode may change)
    if (this.game === "mystery") this.trust = true; // no tools to ask with: always out loud
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("guess_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && this.idOf(c) === this.hostId) this.applySettings(m);
    });
    on("add_bot", (c) => this.handleAddBot(c));
    on<{ id: string }>("remove_bot", (c, m) => this.handleRemoveBot(c, m.id));
    on("start_game", (c) => this.handleStart(c));
    on("sit", (c) => this.handleSit(c));
    on<{ player: string }>("pick", (c, m) => this.handlePick(this.idOf(c), String(m.player)));
    on<Question>("ask", (c, m) => this.handleAsk(this.idOf(c), m));
    on<{ player: string }>("guess", (c, m) => this.handleGuess(this.idOf(c), String(m.player)));
    on("concede", (c) => this.handleConcede(this.idOf(c)));
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

  // ---- joining (as at the other tables) ----

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
      if (this.seats.length >= this.capacity()) throw new ServerError(4409, "full");
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
      bot: false,
      quit: false,
    });
    if (!this.hostId) this.hostId = this.idOf(client);
  }

  /** Back in the waiting room, a spectator takes a seat. */
  private handleSit(client: Client) {
    const options = this.spectators.get(this.idOf(client));
    if (this.phase !== "lobby" || !options) return;
    if (this.seats.length >= this.capacity()) return "full";
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
    return this.seats.find((s) => s.playerId === playerId && s.quit);
  }

  /** Back in his seat, under the id it always had: everything about the game knows him by it. */
  private retakeSeat(seat: Seat) {
    seat.connected = true; // (the match he left stays lost)
  }

  onDrop(client: Client) {
    if (this.admins.has(client.sessionId)) return holdSpectator(this, client);
    if (this.spectators.has(this.idOf(client))) return holdSpectator(this, client);
    const seat = this.seat(this.idOf(client));
    if (seat) seat.connected = false;
    Promise.resolve(this.allowReconnection(client, RECONNECT_SECONDS)).catch(() => {});
    this.sync();
  }

  onReconnect(client: Client) {
    const seat = this.seat(this.idOf(client));
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
    else if (this.phase !== "gameover") this.quit(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.bot && !s.quit && this.connectionOf(s.id))?.id ?? "";
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

  private capacity() {
    return this.mode === "cup" ? this.cupSize : 2;
  }

  private applySettings(s: Settings) {
    // 1 vs 1 or a cup, in the waiting room (back to 1 vs 1 only with two seated at most)
    if (s.mode === "cup" || (s.mode === "duel" && this.seats.length <= 2)) this.mode = s.mode;
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    if (ROUNDS.includes(Number(s.rounds))) this.rounds = Number(s.rounds);
    if (typeof s.random === "boolean") this.random = s.random;
    if (typeof s.level === "string" && Object.hasOwn(LEVELS, s.level)) this.level = s.level;
    if (s.category === "all" || MYSTERY_CATEGORIES.includes(s.category as string)) this.category = s.category as string;
    if (typeof s.same === "boolean") this.same = s.same;
    if (typeof s.trust === "boolean" && this.game === "guess") {
      this.trust = s.trust;
      if (this.trust) this.seats = this.seats.filter((x) => !x.bot); // bots can't talk
    }
    if (typeof s.legends === "boolean" && this.game === "guess") this.legends = s.legends;
    this.legends &&= this.trust;
    const t = Number(s.time);
    if (Number.isInteger(t) && t >= TIME_MIN && t <= TIME_MAX && t % TIME_STEP === 0) this.time = t;
    const size = Number(s.cupSize);
    if (CUP_SIZES.includes(size) && size >= this.seats.length) this.cupSize = size;
    if (typeof s.spectate === "boolean") this.spectate = s.spectate;
    this.updateListing();
  }

  private handleAddBot(client: Client) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId || this.trust) return;
    if (this.seats.length >= this.capacity()) return;
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
      bot: true,
      quit: false,
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
    if (this.seats.length < this.capacity()) return "not_enough_players";
    if (this.mode === "duel") {
      this.matches = [{ a: this.seats[0].id, b: this.seats[1].id, winner: "", rounds: [] }];
      return this.startMatch(0);
    }
    this.matches = bracket(this.seats.map((s) => s.id));
    this.phase = "bracket";
    this.later(BRACKET_MS, () => this.startMatch(0));
  }

  /**
   * Out of the waiting room, and kept out while whoever put him out is here (the host's invite lets him in): by the
   * host, or by a VIP Pro who isn't (3 a month); a VIP Pro only by a VIP Pro.
   */
  private async handleKick(client: Client, id: string) {
    const seat = this.seat(id), by = this.seat(this.idOf(client));
    if (this.phase !== "lobby" || !by || !seat || seat === by || !!seat.bot) return;
    const how = await this.kicks.decide(by, by.name, by.id === this.hostId, seat, this.connectionOf(id));
    if (typeof how === "object") return client.send("guess_error", how);
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

  // ---- a match ----

  private startMatch(index: number): void {
    if (this.matches[index]?.winner) return this.startMatch(index + 1); // a bye: already through
    this.current = index;
    const m = this.matches[index];
    // Someone who left loses without playing (both gone: the first one goes through — and loses his next).
    const gone = (id: string) => this.seat(id)?.quit !== false;
    if (gone(m.a) || gone(m.b)) {
      m.winner = gone(m.a) && !gone(m.b) ? m.b : m.a;
      return this.afterMatch();
    }
    this.sides = [m.a, m.b].map((id): Side => ({ id, secret: "", cat: "", answers: [], wrong: [], clockMs: 0 }));
    this.firstTurn = Math.floor(Math.random() * 2);
    this.roundNo = 0;
    this.startRound();
  }

  private startRound() {
    this.roundNo++;
    this.roundWinner = -1;
    this.turn = "";
    const cats = this.categories();
    for (const [k, s] of this.sides.entries()) {
      Object.assign(s, { secret: "", cat: cats[k], answers: [], wrong: [], clockMs: this.time * 1000 });
    }
    if (this.random) {
      for (const s of this.sides) s.secret = this.draw(s);
      return this.play();
    }
    this.phase = "pick";
    this.endsAt = Date.now() + PICK_MS * GuessRoom.pace;
    for (const s of this.sides) if (this.seat(s.id)?.bot) s.secret = this.draw(s);
    this.later(PICK_MS, () => {
      for (const s of this.sides) s.secret ||= this.draw(s); // too slow: one at random
      this.play();
    });
  }

  private handlePick(id: string, footballer: string) {
    const side = this.sides.find((s) => s.id === id);
    if (this.phase !== "pick" || !side || side.secret) return;
    const known = this.game === "mystery" ? item(footballer)?.cat === side.cat : this.legends ? legend(footballer) : player(footballer);
    if (!known) return "unknown_player";
    side.secret = footballer;
    if (this.sides.every((s) => s.secret)) this.play();
  }

  /** [side]'s secret at random, not the other's: an item of his category, or (at the room's level) a legend or one
   * of today's footballers. */
  private draw(side: Side) {
    const taken = this.sides.find((s) => s !== side)?.secret;
    for (;;) {
      const id =
        this.game === "mystery"
          ? pick(itemsOf(side.cat)).id
          : (this.legends ? randomLegend(this.level) : randomPlayer(this.level)).id;
      if (id !== taken) return id;
    }
  }

  /** Mystery Item: the round's categories, [a's, b's] — the room's one, or any: the same for both or two apart. */
  private categories(): [string, string] {
    if (this.game !== "mystery") return ["", ""];
    if (this.category !== "all") return [this.category, this.category];
    const a = pick(MYSTERY_CATEGORIES);
    return [a, this.same ? a : pick(MYSTERY_CATEGORIES.filter((c) => c !== a))];
  }

  private play() {
    this.phase = "playing";
    if (this.trust) {
      this.endsAt = Date.now() + this.time * 1000;
      return this.later(this.time * 1000, () => this.roundOver(-1), 1);
    }
    this.startTurn(this.sides[(this.firstTurn + this.roundNo - 1) % 2].id);
  }

  private startTurn(id: string) {
    const side = this.side(id)!;
    this.turn = id;
    this.turnStartedAt = Date.now();
    this.later(side.clockMs, () => this.roundOver(1 - this.sides.indexOf(side)), 1); // out of time: the other wins
    if (this.seat(id)?.bot) this.botAct(id);
  }

  /** The turn's time comes off the player's clock. */
  private spend(side: Side) {
    side.clockMs = Math.max(0, side.clockMs - (Date.now() - this.turnStartedAt));
    this.turn = "";
  }

  private handleAsk(id: string, q: Question) {
    const side = this.side(id);
    if (this.phase !== "playing" || this.trust || this.turn !== id || !side) return;
    if (!validQuestion(q)) return "bad_question";
    if (found(side.answers, q.cat)) return "already_found";
    this.spend(side);
    const other = this.sides[1 - this.sides.indexOf(side)];
    const yes = covers(q).has(valueOf(player(other.secret)!, q.cat));
    side.answers.push({ cat: q.cat, items: [...new Set(q.items)], yes });
    this.broadcast("guess_fx", { type: "answer", who: id, cat: q.cat, items: q.items, yes });
    this.later(ANSWER_MS, () => this.startTurn(other.id));
  }

  private handleGuess(id: string, footballer: string) {
    const side = this.side(id);
    if (this.phase !== "playing" || this.trust || this.turn !== id || !side) return;
    if (!player(footballer) || side.wrong.includes(footballer)) return "unknown_player";
    this.spend(side);
    const i = this.sides.indexOf(side), other = this.sides[1 - i];
    const right = footballer === other.secret;
    this.broadcast("guess_fx", { type: "guess", who: id, player: footballer, right });
    if (right) return this.later(ANSWER_MS, () => this.roundOver(i));
    side.wrong.push(footballer); // only the turn is lost
    this.later(ANSWER_MS, () => this.startTurn(other.id));
  }

  /** Trust mode: "he found mine" — the other wins the round. */
  private handleConcede(id: string) {
    const i = this.sides.findIndex((s) => s.id === id);
    if (this.phase === "playing" && this.trust && i >= 0) this.roundOver(1 - i);
  }

  /** The round is over: [winner] takes it (-1: trust mode's time ran out, the round is played again). */
  private roundOver(winner: number) {
    const m = this.matches[this.current];
    this.turn = "";
    this.roundWinner = winner;
    if (winner >= 0) m.rounds.push(winner);
    this.phase = "round";
    this.broadcast("guess_fx", { type: "round", winner });
    const need = Math.ceil(this.rounds / 2);
    const won = [0, 1].findIndex((k) => m.rounds.filter((r) => r === k).length >= need);
    this.later(ROUND_END_MS, () => (won >= 0 ? this.endMatch(won) : this.startRound()));
  }

  private endMatch(winner: number) {
    this.matches[this.current].winner = this.sides[winner].id;
    this.turn = "";
    this.afterMatch();
  }

  /** The cup goes on with the next match (the bracket shows a moment), or the game is over. */
  private afterMatch() {
    const m = this.matches[this.current];
    const slot = this.mode === "cup" ? nextSlot(this.matches.length + 1, this.current) : null;
    if (!slot) {
      this.champion = m.winner;
      this.phase = "gameover";
      this.timer?.clear();
      this.botTimer?.clear();
      this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
      return;
    }
    this.matches[slot.match][slot.side] = m.winner;
    this.phase = "between";
    this.later(BRACKET_MS, () => this.startMatch(this.current + 1));
  }

  /** Who leaves a match in progress loses it; a cup's waiting player loses his match when it comes. */
  private quit(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.quit) return;
    seat.quit = true;
    seat.connected = false;
    const i = this.sides.findIndex((s) => s.id === id);
    if (i >= 0 && ["pick", "playing", "round"].includes(this.phase)) this.endMatch(1 - i);
  }

  // ---- bots ----

  private botAct(id: string) {
    this.botTimer?.clear();
    this.botTimer = this.clock.setTimeout(() => {
      const side = this.side(id);
      if (this.turn !== id || this.phase !== "playing" || !side) return;
      const move = botMove(side.answers, side.wrong);
      if ("guess" in move) this.handleGuess(id, move.guess);
      else this.handleAsk(id, move);
      this.sync();
    }, (1500 + Math.random() * 2500) * GuessRoom.botSpeed);
  }

  // ---- sync ----

  /** [then] in [ms] (shortened by the tests' pace; the players' clocks pass [scale] 1), then everyone is told. */
  private later(ms: number, then: () => void, scale = GuessRoom.pace) {
    this.timer?.clear();
    this.botTimer?.clear();
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms * scale);
  }

  private seat(id: string) {
    return this.seats.find((s) => s.id === id);
  }

  private side(id: string) {
    return this.sides.find((s) => s.id === id);
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
        maxPlayers: this.capacity(),
        spectators: this.spectators.size,
        mode: this.mode,
      },
    });
  }

  /** May [viewer] see [side]'s footballer? His own; everyone's once the round is over; a cup's waiting
   * players when the room allows it. */
  private sees(viewer: string, side: Side) {
    if (viewer === side.id || ["round", "between", "gameover"].includes(this.phase)) return true;
    // (Someone watching without a seat sees what's public only.)
    return this.spectate && this.mode === "cup" && !!this.seat(viewer) && !this.sides.some((s) => s.id === viewer);
  }

  private sync() {
    this.abandon.check(this.seats);
    if ((this.phase !== "lobby") !== this.listedStarted) this.updateListing(); // the list learns the game began, or ended
    const turnSide = this.side(this.turn);
    const table = {
      mode: this.mode,
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      rounds: this.rounds,
      random: this.random,
      level: this.level,
      trust: this.trust,
      legends: this.legends,
      game: this.game,
      category: this.category,
      same: this.same,
      time: this.time,
      cupSize: this.cupSize,
      spectate: this.spectate,
      maxPlayers: this.capacity(),
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, quit: s.quit,
        bot: s.bot ? "normal" : "", // as at the other tables
      })),
      matches: this.matches,
      current: this.current,
      round: this.roundNo,
      turn: this.turn,
      turnEndsAt: turnSide ? this.turnStartedAt + turnSide.clockMs : 0,
      endsAt: this.endsAt,
      roundWinner: this.roundWinner,
      champion: this.champion,
      spectators: this.spectators.size,
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = this.idOf(client);
      const sides = this.sides.map((s) => ({
        id: s.id, cat: s.cat, answers: s.answers, wrong: s.wrong, clockMs: s.clockMs, secret: this.sees(me, s) ? s.secret : "",
      }));
      client.send("guess", { ...table, sides, me });
    }
    for (const id of this.admins) this.clients.getById(id)?.send("god", { secrets: Object.fromEntries(this.sides.map((s) => [s.id, s.secret])) });
  }
}

/** Mystery Item: Guess Who's room with things to find instead of footballers (see above). */
export class MysteryRoom extends GuessRoom {
  protected override game = "mystery" as const;
}

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
