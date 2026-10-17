import { Room, Client, ServerError } from "colyseus";
import { randomAvatar, randomFrame } from "../avatars.js";
import { accountFor, accountsEnabled, isAdmin, isFriendOfAny, vipLevel, type Account } from "../accounts.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { CATEGORIES, WORDS, wordsOf, type Word } from "../imposterWords.js";
import { closeVoice, dropFromVoice, setVoiceRights, voiceEnabled, voiceToken } from "../voice.js";
import { Abandon, holdSpectator } from "./abandoned.js";
import { TableTalk } from "./tableTalk.js";
import { kickRefusal, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";

/**
 * Imposter: everyone gets the same secret word, except one to four imposters who only know its category. They
 * talk (the mic) until the timer ends or most of them want to vote, then everyone votes (or skips). The most
 * voted player is revealed: an imposter gets one guess at the word — right, and the imposters win anyway.
 * One vote decides the game, or (a room setting) the voted player is out and the rounds go on until the
 * imposters are all out, or as many as the others. A tie, or skips as many as the top vote: nobody is out.
 * Winners score 1 point, imposters 2; the scores stay for the room's next games.
 *
 * No schema: everyone gets the "imposter" message after every change (with his own card only).
 */
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; started: boolean;
  players: number; maxPlayers: number; spectators: number;
};
type Settings = { roomType?: string; imposters?: number; category?: string; talk?: number; mode?: string };
type JoinOptions = Settings & { admin?: boolean; name?: string; playerId?: string; idToken?: string; spectator?: boolean };
type Seat = {
  id: string;
  playerId: string;
  name: string;
  uid: string;
  avatar: number;
  frame: number;
  vip?: string; // "vip" | "pro": his badge by his name
  connected: boolean;
  imposter: boolean;
  out: boolean; // voted out, or left the game
  left: boolean;
  seen: boolean; // has looked at his card
  wantsVote: boolean; // pressed "vote" during the talk
  vote: string | null; // during the vote: who ("" skips), null not yet
  score: number;
  gained: number; // the last game's points
};
type Phase = "lobby" | "reveal" | "talk" | "vote" | "verdict" | "guess" | "result";

const ROOM_TYPES = ["public", "friends", "private"];
const TALK_OPTIONS = [60, 120, 180, 300, 600, 900]; // the talk: 1 to 15 minutes
const MAX_SEATS = 12;
const MAX_SPECTATORS = 20;
const LOG_LINES = 30;
const MIN_PLAYERS = 3;
const REVEAL_MS = 20_000; // looking at one's card
const VOTE_MS = 30_000;
const VERDICT_MS = 4_000; // who was voted out, and what he was
const GUESS_MS = 25_000;
const RECONNECT_SECONDS = 600;

export class ImposterRoom extends Room<{ metadata: Meta }> {
  private abandon = new Abandon(this); // nobody left to play: the room closes by itself
  static pace = 1; // tests: every timer shorter
  maxClients = MAX_SEATS + MAX_SPECTATORS; // the seats are counted in onAuth

  private phase: Phase = "lobby";
  private hostId = "";
  private roomType = "public";
  private imposters = 1;
  private category = "random"; // or one of CATEGORIES
  private talkSeconds = 180;
  private mode: "single" | "elimination" = "single";
  private seats: Seat[] = [];
  private members = new Map<string, string>(); // sessionId → account uid (friends rooms)
  private invited = new Set<string>();
  private banned = new Map<string, string>(); // a kicked player's id → who kicked him (the host then)
  private spectators = new Map<string, JoinOptions>(); // sessionId → how he came: watching a game, without a seat
  private tableTalk!: TableTalk; // the table's chat and emojis
  private admins = new Set<string>(); // the admin app watching, unseen (its God Eye: who the imposters are, and the word)
  private returned = new Map<string, string>(); // a returning player's new connection → the seat he had
  private listedStarted = false; // what the room list was last told
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" }; // …and whose face it shows
  private looks = new RoomLooks(); // a VIP Pro host's name and style for his room in the lists (kept on his account)
  private get look() {
    return this.looks.of(this.hostId);
  }
  private log: { type: "joined" | "left"; name: string; at: number }[] = []; // the waiting room's comings and goings
  private word: Word | null = null;
  private round = 0;
  private endsAt = 0;
  private votedOut = ""; // the vote's result ("" nobody)
  private guessed = ""; // the caught imposter's guess (a word id)
  private winner: "" | "players" | "imposters" = "";
  private timer: { clear(): void } | null = null;

  onCreate(options: JoinOptions = {}) {
    this.applySettings(options);
    const on = <T>(type: string, handler: (client: Client, msg: T) => string | void) =>
      this.onMessage(type, (client, msg: T) => {
        const error = handler(client, msg ?? ({} as T));
        if (error) client.send("imposter_error", { code: error });
        this.sync();
      });
    on<Settings>("settings", (c, m) => {
      if (this.phase === "lobby" && this.idOf(c) === this.hostId) this.applySettings(m);
    });
    on("start_game", (c) => this.handleStart(c));
    on("seen", (c) => this.handleSeen(this.idOf(c)));
    on("vote_now", (c) => this.handleVoteNow(this.idOf(c)));
    on<{ target?: string }>("vote", (c, m) => this.handleVote(this.idOf(c), String(m.target ?? "")));
    on<{ word?: string }>("guess", (c, m) => this.handleGuess(this.idOf(c), String(m.word ?? "")));
    on("play_again", (c) => this.handlePlayAgain(c));
    on("sit", (c) => this.handleSit(c));
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
      if (this.seats.length >= MAX_SEATS) throw new ServerError(4409, "full");
    }
    if (this.roomType !== "public" && this.seats.length > 0) {
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
    const name = account?.name ?? (String(options.name ?? "").trim().slice(0, 24) || `Player-${this.idOf(client).slice(0, 4)}`);
    this.note("joined", name);
    this.seats.push({
      id: this.idOf(client),
      playerId,
      name,
      uid: account?.uid ?? "",
      avatar: account?.avatar ?? randomAvatar(), // no account (a test client): a character at random
      frame: account?.frame ?? randomFrame(),
      vip: vipLevel(account),
      connected: true,
      imposter: false,
      out: false,
      left: false,
      seen: false,
      wantsVote: false,
      vote: null,
      score: ghost?.score ?? 0,
      gained: 0,
    });
    if (!this.hostId) this.hostId = this.idOf(client);
  }

  /** Back in the waiting room, a spectator takes a seat. */
  private handleSit(client: Client) {
    const options = this.spectators.get(this.idOf(client));
    if (this.phase !== "lobby" || !options) return;
    if (this.seats.length >= MAX_SEATS) return "full";
    this.spectators.delete(this.idOf(client));
    this.addSeat(client, options);
    this.voice(this.seat(this.idOf(client))!, true);
    this.updateListing();
  }

  private note(type: "joined" | "left", name: string) {
    this.log = [...this.log, { type, name, at: Date.now() }].slice(-LOG_LINES);
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
    return this.seats.find((s) => s.playerId === playerId && s.left);
  }

  /** Back in his seat, under the id it always had: everything about the game knows him by it. */
  private retakeSeat(seat: Seat) {
    seat.left = false; // (leaving put him out of the game: he's back among those who are out)
    seat.connected = true;
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
    const leaving = this.seat(id);
    if (leaving && this.phase === "lobby") this.note("left", leaving.name);
    if (this.phase === "lobby" || this.phase === "result") this.removeSeat(id);
    else this.leaveGame(id);
    if (this.hostId === id) this.hostId = this.seats.find((s) => !s.left && this.connectionOf(s.id))?.id ?? "";
    this.updateListing();
    this.sync();
  }

  onDispose() {
    this.timer?.clear();
    if (voiceEnabled) closeVoice(this.roomId).catch(() => {});
  }

  private async handleVoiceJoin(client: Client) {
    if (!voiceEnabled) return client.send("voice", { enabled: false });
    if (this.admins.has(client.sessionId)) { // the admin listens, unseen
      return client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, client.sessionId, "admin", { talk: false, hear: true }, false, true)) });
    }
    const seat = this.seat(this.idOf(client));
    const talk = !!seat && !seat.out; // a spectator listens
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, this.idOf(client), this.voiceName(client), { talk, hear: true })) });
    if (this.inGraveyard(this.idOf(client))) this.sendGrave(client);
  }

  /** Who's out of the game hears the table but doesn't talk to it; back in the waiting room, everyone talks again. */
  private voice(seat: Seat, talk: boolean) {
    if (voiceEnabled && !seat.left) setVoiceRights(this.roomId, seat.id, { talk, hear: true }).catch(() => {});
  }

  private voiceName(client: Client) {
    return this.seat(this.idOf(client))?.name ?? client.auth?.account?.name ?? "spectator";
  }

  /** Out of a running game, or watching it: with the others like him, in the graveyard's voice. */
  private inGraveyard(id: string) {
    if (this.phase === "lobby" || this.phase === "result") return false;
    const seat = this.seat(id);
    return seat ? seat.out && !seat.left : this.spectators.has(id);
  }

  /** The graveyard's voice: they talk there among themselves, the table never hears them. */
  private async sendGrave(client: Client | undefined) {
    if (!voiceEnabled || !client) return;
    const access = await voiceToken(this.roomId, this.idOf(client), this.voiceName(client), { talk: true, hear: true }, true);
    client.send("voice_grave", access);
  }

  // ---- the waiting room ----

  private applySettings(s: Settings) {
    if (ROOM_TYPES.includes(s.roomType as string)) this.roomType = s.roomType as string;
    const n = Number(s.imposters);
    if (Number.isInteger(n) && n >= 1 && n <= 4) this.imposters = n;
    if (s.category === "random" || CATEGORIES.includes(s.category as string)) this.category = s.category as string;
    if (TALK_OPTIONS.includes(Number(s.talk))) this.talkSeconds = Number(s.talk);
    if (s.mode === "single" || s.mode === "elimination") this.mode = s.mode;
    this.updateListing();
  }

  private handleStart(client: Client) {
    if (this.phase !== "lobby" || this.idOf(client) !== this.hostId) return;
    if (this.seats.length < MIN_PLAYERS) return "not_enough_players";
    // The imposters are always fewer than the others: two need five players, three seven, four nine.
    if (this.seats.length < 2 * this.imposters + 1) return this.imposters === 2 ? "too_few_for_two" : "too_few_imposters";
    for (const id of this.spectators.keys()) this.sendGrave(this.connectionOf(id)); // still watching from the last game
    const pool = this.category === "random" ? WORDS : wordsOf(this.category);
    this.word = pool[Math.floor(Math.random() * pool.length)];
    const order = this.seats.map((_, i) => i).sort(() => Math.random() - 0.5);
    this.seats.forEach((s, i) =>
      Object.assign(s, { imposter: order.indexOf(i) < this.imposters, out: false, seen: false, wantsVote: false, vote: null, gained: 0 }),
    );
    this.round = 1;
    this.votedOut = "";
    this.guessed = "";
    this.winner = "";
    this.phase = "reveal";
    this.endsAt = Date.now() + REVEAL_MS * ImposterRoom.pace;
    this.later(REVEAL_MS, () => this.talk());
  }

  /**
   * Out of the waiting room, and kept out while whoever put him out is here (the host's invite lets him in): by the
   * host, or by a VIP Pro who isn't (3 a month); a VIP Pro only by a VIP Pro.
   */
  private async handleKick(client: Client, id: string) {
    const seat = this.seat(id), by = this.seat(this.idOf(client));
    if (this.phase !== "lobby" || !by || !seat || seat === by) return;
    const refused = await kickRefusal(by, by.id === this.hostId, seat);
    if (refused) return client.send("imposter_error", { code: refused });
    if (this.phase !== "lobby" || !this.seat(id)) return; // (the game began, or he left, meanwhile)
    this.banned.set(seat.playerId, by.playerId);
    const kicked = this.connectionOf(id);
    kicked?.send("kicked");
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
    if (this.hostId === id) this.hostId = this.seats[0]?.id ?? "";
  }

  // ---- the game ----

  private alive() {
    return this.seats.filter((s) => !s.out);
  }

  private handleSeen(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "reveal" || !seat) return;
    seat.seen = true;
    if (this.alive().every((s) => s.seen || !s.connected)) this.talk();
  }

  private talk() {
    this.phase = "talk";
    this.votedOut = "";
    for (const s of this.seats) s.wantsVote = false;
    this.endsAt = Date.now() + this.talkSeconds * 1000;
    this.later(this.talkSeconds * 1000, () => this.vote(), 1);
  }

  /** "Let's vote": once more than half of the players still in want to, the vote starts. */
  private handleVoteNow(id: string) {
    const seat = this.seat(id);
    if (this.phase !== "talk" || !seat || seat.out) return;
    seat.wantsVote = !seat.wantsVote;
    const alive = this.alive();
    if (alive.filter((s) => s.wantsVote).length * 2 > alive.length) this.vote();
  }

  private vote() {
    this.phase = "vote";
    for (const s of this.seats) s.vote = null;
    this.endsAt = Date.now() + VOTE_MS * ImposterRoom.pace;
    this.later(VOTE_MS, () => this.tally());
  }

  private handleVote(id: string, target: string) {
    const seat = this.seat(id);
    if (this.phase !== "vote" || !seat || seat.out) return;
    if (target && (target === id || !this.alive().some((s) => s.id === target))) return;
    seat.vote = target; // "" skips; a new vote replaces the last one until everyone has voted
    if (this.alive().every((s) => s.vote !== null || !s.connected)) this.tally();
  }

  /** The most voted is out — unless it's a tie, or as many skipped (not voting is skipping). */
  private tally() {
    const counts = new Map<string, number>();
    let skips = 0;
    for (const s of this.alive()) {
      if (s.vote) counts.set(s.vote, (counts.get(s.vote) ?? 0) + 1);
      else skips++;
    }
    let top = "", best = 0, tie = false;
    for (const [target, n] of counts) {
      if (n > best) [top, best, tie] = [target, n, false];
      else if (n === best) tie = true;
    }
    this.votedOut = !tie && best > skips ? top : "";
    this.phase = "verdict";
    this.endsAt = 0;
    this.later(VERDICT_MS, () => this.afterVerdict());
  }

  private afterVerdict() {
    const out = this.seat(this.votedOut);
    if (!out) return this.mode === "single" ? this.finish("imposters") : this.nextRound();
    if (out.imposter) {
      // Caught: one guess at the word.
      this.phase = "guess";
      this.guessed = "";
      this.endsAt = Date.now() + GUESS_MS * ImposterRoom.pace;
      return this.later(GUESS_MS, () => this.afterGuess(false));
    }
    if (this.mode === "single") return this.finish("imposters");
    this.knockOut(out);
    if (!this.decided()) this.nextRound();
  }

  private handleGuess(id: string, word: string) {
    if (this.phase !== "guess" || id !== this.votedOut || !this.word) return;
    if (!wordsOf(this.word.cat).some((w) => w.id === word)) return "unknown_word";
    this.guessed = word;
    this.afterGuess(word === this.word.id);
  }

  private afterGuess(right: boolean) {
    if (right) return this.finish("imposters");
    if (this.mode === "single") return this.finish("players");
    this.knockOut(this.seat(this.votedOut)!);
    if (!this.decided()) this.nextRound();
  }

  private knockOut(seat: Seat) {
    seat.out = true;
    this.voice(seat, false);
    this.sendGrave(this.connectionOf(seat.id));
  }

  /** All the imposters out: the players win; as many imposters as the others: the imposters win. */
  private decided() {
    const alive = this.alive();
    const imposters = alive.filter((s) => s.imposter).length;
    if (imposters === 0) this.finish("players");
    else if (imposters >= alive.length - imposters) this.finish("imposters");
    else return false;
    return true;
  }

  private nextRound() {
    this.round++;
    this.talk();
  }

  /** Someone leaves mid-game: he's out (an imposter caught on his way out guesses nothing). */
  private leaveGame(id: string) {
    const seat = this.seat(id);
    if (!seat || seat.left) return;
    seat.left = true;
    seat.connected = false;
    if (seat.out) return;
    seat.out = true;
    if (this.phase === "guess" && id === this.votedOut) return this.afterGuess(false);
    if (this.decided()) return;
    if (this.phase === "reveal" && this.alive().every((s) => s.seen || !s.connected)) this.talk();
    else if (this.phase === "vote" && this.alive().every((s) => s.vote !== null || !s.connected)) this.tally();
  }

  private finish(winner: "players" | "imposters") {
    this.timer?.clear();
    this.winner = winner;
    this.phase = "result";
    this.endsAt = 0;
    for (const s of this.seats) {
      s.gained = winner === "imposters" ? (s.imposter ? 2 : 0) : s.imposter ? 0 : 1;
      s.score += s.gained;
      this.voice(s, true);
    }
    if (voiceEnabled) closeVoice(this.roomId, { graveOnly: true }).catch(() => {}); // everyone together again
  }

  /** The host takes everyone back to the waiting room (the scores stay); newcomers can join again. */
  private handlePlayAgain(client: Client) {
    if (this.phase !== "result" || this.idOf(client) !== this.hostId) return;
    this.seats = this.seats.filter((s) => !s.left);
    for (const s of this.seats) Object.assign(s, { imposter: false, out: false, seen: false, wantsVote: false, vote: null });
    this.word = null;
    this.phase = "lobby";
    this.updateListing();
  }

  // ---- sync ----

  /** [then] in [ms] (shortened by the tests' pace; the talk passes [scale] 1), then everyone is told. */
  private later(ms: number, then: () => void, scale = ImposterRoom.pace) {
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => (then(), this.sync()), ms * scale);
  }

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
        maxPlayers: MAX_SEATS,
        spectators: this.spectators.size,
      },
    });
  }

  private sync() {
    this.abandon.check(this.seats);
    if ((this.phase !== "lobby") !== this.listedStarted) this.updateListing(); // the list learns the game began, or ended
    const over = this.phase === "result";
    const counts: Record<string, number> = {};
    let skips = 0;
    if (this.phase === "vote" || this.phase === "verdict") {
      for (const s of this.alive()) {
        if (s.vote) counts[s.vote] = (counts[s.vote] ?? 0) + 1;
        else if (s.vote === "") skips++;
      }
    }
    // Roles are secret until the end, but whoever is voted out is shown for what he is.
    const known = (s: Seat) => over || (s.out && !s.left) || (s.id === this.votedOut && ["verdict", "guess"].includes(this.phase));
    const word = this.word && { id: this.word.id, en: this.word.en, fr: this.word.fr, ar: this.word.ar };
    const table = {
      phase: this.phase,
      hostId: this.hostId,
      roomType: this.roomType,
      imposters: this.imposters,
      category: this.category,
      talk: this.talkSeconds,
      mode: this.mode,
      seats: this.seats.map((s) => ({
        id: s.id, name: s.name, uid: s.uid, avatar: s.avatar, frame: s.frame, vip: s.vip ?? "", connected: s.connected, bot: "",
        out: s.out, left: s.left, seen: s.seen, wantsVote: s.wantsVote, voted: s.vote !== null,
        role: known(s) ? (s.imposter ? "imposter" : "player") : "", score: s.score, gained: s.gained,
      })),
      wordCategory: this.word?.cat ?? "",
      round: this.round,
      endsAt: this.endsAt,
      counts,
      skips,
      votedOut: this.votedOut,
      guessed: over ? this.guessed : "",
      word: over ? word : null,
      winner: this.winner,
      spectators: this.spectators.size,
      log: this.phase === "lobby" ? this.log : [],
      serverNow: Date.now(),
    };
    for (const client of this.clients) {
      const me = this.seat(this.idOf(client));
      const playing = this.phase !== "lobby" && me && this.word;
      client.send("imposter", {
        ...table,
        me: this.idOf(client),
        card: playing ? (me.imposter ? { imposter: true } : { imposter: false, word }) : null,
        myVote: me?.vote ?? null,
        // The caught imposter's last chance: the category's words.
        options: this.phase === "guess" && me?.id === this.votedOut && this.word ? wordsOf(this.word.cat) : [],
      });
    }
    for (const id of this.admins) this.clients.getById(id)?.send("god", { imposters: this.seats.filter((s) => s.imposter).map((s) => s.id), word: this.word && { id: this.word.id, en: this.word.en, fr: this.word.fr, ar: this.word.ar } });
  }
}
