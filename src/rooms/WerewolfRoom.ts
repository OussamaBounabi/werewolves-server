import { Room, Client, ServerError } from "colyseus";
import { WerewolfState, PlayerState } from "./schema/WerewolfState.js";
import { accountFor, firebaseEnabled, recordResults, rewardFor, type Account, type GameResult } from "../firebase.js";

const SPECIALS = ["seer", "witch", "protector", "hunter", "wildhunter", "detective", "bear", "redhood", "tripleface"] as const;
type Special = (typeof SPECIALS)[number];
type Role = "werewolf" | "villager" | Special;
type Meta = { host: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type JoinOptions = { name?: string; playerId?: string; spectator?: boolean; idToken?: string };
type VoteRecord = { day: number; excluded: string | null; ballots: Record<string, string>; mayorId: string };
/** One line of the event log; clients render it in their language from [type] and its params. */
type GameEvent = { seq: number; time: number; type: string; [param: string]: unknown };
/** Why a player died — each one has its own line over the card reveal in the app. */
type DeathCause = "wolves" | "witch" | "trap" | "hunter" | "vote" | "quit" | "timeout";
type ChatLine = { from: string; name: string; text: string; wolvesOnly: boolean };
/** Roles the host picked for the room: counts for wolves/villagers, in-or-out for the rest. */
type Composition = { werewolf: number; villager: number } & Record<Special, boolean>;
/** What the host can change in the lobby (also accepted as create options). */
type Settings = {
  roomType?: string;
  maxPlayers?: number;
  roundSeconds?: number;
  wolves?: number;
  villagers?: number;
  testRole?: string | null;
} & Partial<Record<Special, boolean>>;
type Potions = { revive: boolean; poison: boolean }; // potions not used yet

const ROLES: readonly Role[] = ["werewolf", "villager", ...SPECIALS];
/** When fewer players join than the mix plans, specials leave the deck in this order. */
const DROP_ORDER: readonly Special[] = ["redhood", "bear", "tripleface", "detective", "wildhunter", "hunter", "protector", "witch", "seer"];
const ROOM_TYPES = ["public", "friends", "private"];
const ROUND_OPTIONS = [10, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 30)]; // 10s, 30s … 15min
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const STEP_MS = 10_000; // night steps and votes — TEMPORARY fixed value, the user wants it configurable later
const RECONNECT_SECONDS = 600; // a dropped player's seat is held 10 minutes, then he dies
const ROOM_LIFESPAN_MS = 60 * 60_000; // a room lives at most 1 hour from creation
const CLOSE_AFTER_GAME_MS = 60_000; // after the game ends, the room closes a minute later
const MAX_CONNECTIONS = 100; // players + spectators; the player limit is maxPlayers, checked in onAuth
const CHAT_MAX = 200;
const DEAL_MS = 3_500; // the app's role-card deal animation, on top of night 1's first step
const REVEAL_MS = 4_500; // the app's card reveal for one death; the game waits for them before moving on

export class WerewolfRoom extends Room<{ state: WerewolfState; metadata: Meta }> {
  maxClients = MAX_CONNECTIONS;
  state = new WerewolfState();

  // Server-only — never synced to clients, so role/night info can't leak.
  private roles = new Map<string, Role>();
  private playerIds = new Map<string, string>(); // sessionId → the account uid (or the device's id for guests)
  private accounts = new Map<string, string>(); // sessionId → account uid, for players signed in
  private gameStartedAt = 0;
  private quitAlive = new Map<string, number>(); // left the game while alive → counted as a loss (and when)
  private banned = new Set<string>(); // player ids kicked by the current host
  private spectators = new Set<string>(); // sessionIds watching, not playing
  private dropped = new Set<string>(); // players whose connection dropped (seat held)
  private heldSeats = new Map<string, { reject: Function }>(); // pending reconnections (Colyseus Deferred)
  private voteHistory: VoteRecord[] = [];
  private known = new Map<string, Record<string, string>>(); // seer / triple face → roles they've seen (for reconnects)
  private detectiveKnown: { a: string; b: string; same: boolean }[] = [];
  private detectiveChecked = new Set<string>(); // a checked player can never be checked again
  // The event log and chat live on the server, so a reconnecting or relaunched app gets them back.
  private publicLog: GameEvent[] = [];
  private privateLogs = new Map<string, GameEvent[]>(); // sessionId → events only that player saw
  private eventSeq = 0;
  private chatLog: ChatLine[] = [];
  private wolfChatLog: ChatLine[] = [];
  private closeTimer: { clear(): void } | null = null;
  private testHostRole: Role | null = null; // TEST ONLY: host picks their own role
  private phaseTimer: { clear(): void } | null = null;
  private lastSnapshot = "";

  // Per night
  private trapTarget: string | null = null; // the Wild Hunter's trap (odd nights)
  private protectTarget: string | null = null;
  private wolfVotes = new Map<string, string>(); // wolf -> target
  private wolfTarget: string | null = null; // who the pack went for — the trap springs even if he was protected
  private wolfVictim: string | null = null; // after protection, Red Hood and ties
  private awake = new Set<string>(); // witch/seer step: who still has to act
  private witchActors = new Set<string>(); // acting as a witch tonight (the witch, the triple face on night 2)
  private reviving = false;
  private poisons = new Map<string, string>(); // poisoner → target

  // Per game
  private potions = new Map<string, Potions>();
  private lastProtected: string | null = null; // can't be protected two nights in a row
  private dealTime = 0; // DEAL_MS for the first night step of the game, then 0
  private revealsPending = 0; // deaths whose card reveal the clients are about to play
  private pendingShooters: string[] = []; // dead hunters waiting for their shot
  private mayorElected = false; // the village elects once; a dead mayor can only hand the title on
  private pendingSuccession: string | null = null; // mayor who just died and picks a successor

  // The Flutter client reads state from this plain message instead of Colyseus's binary patches.
  onBeforePatch() {
    const snapshot = this.state.toJSON();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshot) return;
    this.lastSnapshot = json;
    this.broadcast("state", { ...snapshot, serverNow: Date.now() });
  }

  onCreate(options: Settings = {}) {
    this.applySettings(options);
    this.clock.setTimeout(() => this.expire(), ROOM_LIFESPAN_MS);

    this.onMessage("settings", (client, msg: Settings) => {
      if (this.state.phase === "lobby" && client.sessionId === this.state.hostId) this.applySettings(msg ?? {});
    });
    this.onMessage("kick", (client, msg: { targetId: string }) => this.handleKick(client, msg));
    this.onMessage("start_game", (client) => this.handleStartGame(client));
    this.onMessage("cancel_start", (client) => this.handleCancelStart(client));
    this.onMessage("trap", (client, msg: { targetId: string }) => this.handleTrap(client, msg));
    this.onMessage("protect", (client, msg: { targetId: string }) => this.handleProtect(client, msg));
    this.onMessage("wolf_target", (client, msg: { targetId: string }) => this.handleWolfTarget(client, msg));
    this.onMessage("seer_peek", (client, msg: { targetId: string }) => this.handleSeerPeek(client, msg));
    this.onMessage("witch_revive", (client) => this.handleWitchRevive(client));
    this.onMessage("witch_poison", (client, msg: { targetId: string }) => this.handleWitchPoison(client, msg));
    this.onMessage("witch_pass", (client) => this.handleWitchPass(client));
    this.onMessage("detective_check", (client, msg: { a: string; b: string }) => this.handleDetective(client, msg));
    this.onMessage("hunter_aim", (client, msg: { targetId: string }) => this.handleHunterAim(client, msg));
    this.onMessage("hunter_shoot", (client, msg: { targetId: string }) => this.handleHunterShoot(client, msg));
    this.onMessage("day_vote", (client, msg: { targetId: string }) => this.handleDayVote(client, msg));
    this.onMessage("mayor_successor", (client, msg: { targetId: string }) => this.handleSuccessor(client, msg));
    this.onMessage("mayor_pass", (client) => this.handleSuccessor(client, null));
    this.onMessage("chat", (client, msg: { text: string }) => this.handleChat(client, msg));
  }

  /**
   * Runs when the client's socket connects (not on reconnects): the player's account (from his app's
   * Firebase login token), bans, spectators, and the player limit. Returns what onJoin gets as client.auth.
   */
  async onAuth(_client: Client, options: JoinOptions = {}): Promise<{ account: Account | null }> {
    // ponytail: guests (no token) are still allowed, for the bots and tests; require a token for release.
    let account: Account | null = null;
    if (options.idToken && firebaseEnabled) {
      try {
        account = await accountFor(String(options.idToken));
      } catch {
        throw new ServerError(4401, "auth");
      }
    }
    const playerId = account?.uid ?? options.playerId;
    if (playerId && this.banned.has(String(playerId))) throw new ServerError(4403, "banned");
    if (!options.spectator) {
      if (this.state.phase !== "lobby") throw new ServerError(4409, "started");
      if (this.state.players.size >= this.state.maxPlayers) throw new ServerError(4409, "full");
    }
    return { account };
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    this.sendHistory(client);
    if (options.spectator) {
      this.spectators.add(client.sessionId);
      this.state.spectators = this.spectators.size;
      return this.updateListing();
    }
    const account: Account | null = client.auth?.account ?? null;
    const name = account?.name ?? (String(options.name ?? "").trim().slice(0, 24) || `Player-${client.sessionId.slice(0, 4)}`);
    this.playerIds.set(client.sessionId, account?.uid ?? String(options.playerId ?? client.sessionId));
    if (account) this.accounts.set(client.sessionId, account.uid);
    this.state.players.set(client.sessionId, new PlayerState({
      sessionId: client.sessionId,
      name,
      uid: account?.uid ?? "",
      avatar: account?.avatar ?? 0,
    }));
    this.logEvent(this.state.hostId ? "joined" : "created", { name });
    if (!this.state.hostId) this.setHost(client.sessionId);
    this.updateListing();
  }

  /** Adds to the event log and sends it: to everyone, or only to [onlyFor] (kept for his reconnects). */
  private logEvent(type: string, params: Record<string, unknown> = {}, onlyFor?: string) {
    const event: GameEvent = { seq: ++this.eventSeq, time: Date.now(), type, ...params };
    if (!onlyFor) {
      this.publicLog.push(event);
      this.broadcast("event", event);
      return;
    }
    if (!this.privateLogs.has(onlyFor)) this.privateLogs.set(onlyFor, []);
    this.privateLogs.get(onlyFor)!.push(event);
    this.clients.getById(onlyFor)?.send("event", event);
  }

  /** Everything a (re)joining app needs to rebuild its screens: event log, chat, vote history. */
  private sendHistory(client: Client) {
    const id = client.sessionId;
    const mine = this.privateLogs.get(id) ?? [];
    client.send("events", [...this.publicLog, ...mine].sort((a, b) => a.seq - b.seq));
    const chat = this.roles.get(id) === "werewolf" ? [...this.chatLog, ...this.wolfChatLog] : this.chatLog;
    client.send("chat_history", chat);
    client.send("vote_history", this.voteHistory);
  }

  private nameOf(id: string | null | undefined) {
    return (id && this.state.players.get(id)?.name) || null;
  }

  // Network drop or app closed: hold the seat 10 minutes so the app can come back.
  onDrop(client: Client) {
    if (this.spectators.has(client.sessionId)) return; // nothing to hold — onLeave runs next
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    this.dropped.add(client.sessionId);
    const seat = this.allowReconnection(client, RECONNECT_SECONDS);
    this.heldSeats.set(client.sessionId, seat);
    // Rejects when the seat expires (onLeave then runs), on a kick, or if the client never finished joining.
    Promise.resolve(seat).catch(() => {});
  }

  onReconnect(client: Client) {
    const id = client.sessionId;
    const player = this.state.players.get(id);
    if (player) player.connected = true;
    this.dropped.delete(id);
    this.heldSeats.delete(id);
    // Private messages sent while away are lost, and a relaunched app knows nothing: send it all again.
    this.sendRole(id);
    const role = this.roles.get(id);
    if (this.known.has(id)) client.send("seer_known", this.known.get(id));
    if (role === "detective") client.send("detective_known", this.detectiveKnown);
    if (role === "werewolf" && this.state.nightStep === "wolves") client.send("wolf_votes", Object.fromEntries(this.wolfVotes));
    if (this.state.nightStep === "witch_seer" && this.witchActors.has(id) && this.awake.has(id)) this.sendWitchTurn(id);
    if (role === "protector" && this.state.nightStep === "protector") this.sendProtectorTurn(id);
    this.sendHistory(client);
    client.send("state", { ...this.state.toJSON(), serverNow: Date.now() });
  }

  onLeave(client: Client) {
    const id = client.sessionId;
    if (this.spectators.delete(id)) {
      this.state.spectators = this.spectators.size;
      return this.updateListing();
    }
    const player = this.state.players.get(id);
    const timedOut = this.dropped.delete(id);
    this.heldSeats.delete(id);
    if (!player) return;
    if (this.state.phase === "lobby" || this.state.phase === "starting") {
      this.removeFromLobby(id); // during the start countdown he just misses the game
    } else if (this.state.phase !== "gameover") {
      // Quitting on purpose is final; a dropped player who never came back dies too.
      player.connected = false;
      this.removeFromGame(id, timedOut ? "timeout" : "quit");
    } else {
      player.connected = false;
    }
    this.updateListing();
  }

  private removeFromLobby(id: string, kicked = false) {
    this.logEvent(kicked ? "kicked" : "left", { name: this.nameOf(id) });
    this.state.players.delete(id);
    this.playerIds.delete(id);
    if (this.state.hostId !== id) return;
    const next = this.state.players.keys().next().value ?? "";
    this.setHost(next);
    if (next) this.logEvent("new_host", { name: this.nameOf(next) });
  }

  /** A player gone for good mid-game dies on the spot, outside any night/vote resolution. */
  private removeFromGame(id: string, reason: "quit" | "timeout") {
    if (!this.isAlive(id)) return;
    this.quitAlive.set(id, Date.now()); // leaving alive is a loss, whatever his team does
    this.kill(id, reason);
    const role = this.roles.get(id);
    this.broadcast("player_gone", { id, reason, role });
    this.logEvent("player_gone", { name: this.nameOf(id), role, reason });
    if (this.pendingSuccession === id) {
      // He isn't here to name a successor: the village has no mayor from now on.
      this.pendingSuccession = null;
      this.broadcast("mayor_result", { mayorId: null, successor: true });
      this.logEvent("mayor", { name: null, successor: true });
    }
    this.endGameIfOver();
  }

  /** Host only, waiting room only: removes a player and bans him until the host changes. */
  private handleKick(client: Client, msg: { targetId: string }) {
    const target = msg?.targetId;
    if (this.state.phase !== "lobby" || client.sessionId !== this.state.hostId) return;
    if (!target || target === client.sessionId || !this.state.players.has(target)) return;
    this.banned.add(this.playerIds.get(target) ?? target);
    this.heldSeats.get(target)?.reject("kicked"); // a disconnected player's held seat
    const kicked = this.clients.getById(target);
    kicked?.send("kicked");
    this.removeFromLobby(target, true);
    this.updateListing();
    kicked?.leave(4000);
  }

  /** The 1-hour limit: an unfinished game ends with no winner (endGame then closes the room). */
  private expire() {
    if (this.state.phase !== "gameover") this.endGame(null);
  }

  /** What the lobby screen lists for this room. */
  private updateListing() {
    const host = this.state.players.get(this.state.hostId)?.name ?? "";
    this.setMatchmaking({
      maxClients: MAX_CONNECTIONS,
      metadata: {
        host,
        started: this.state.phase !== "lobby", // "starting" counts: joining is closed
        players: this.state.players.size,
        maxPlayers: this.state.maxPlayers,
        spectators: this.spectators.size,
      },
    });
  }

  /** Validates and applies host settings; anything missing or invalid keeps its current value. */
  private applySettings(s: Settings) {
    const st = this.state;
    const int = (v: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v)) || min));
    if (ROOM_TYPES.includes(s.roomType as string)) st.roomType = s.roomType as string;
    if (s.maxPlayers !== undefined) st.maxPlayers = int(s.maxPlayers, Math.max(MIN_PLAYERS, st.players.size), MAX_PLAYERS);
    if (ROUND_OPTIONS.includes(Number(s.roundSeconds))) st.roundSeconds = Number(s.roundSeconds);
    if (s.wolves !== undefined) st.wolves = int(s.wolves, 1, 8);
    if (s.villagers !== undefined) st.villagers = int(s.villagers, 0, 12);
    for (const r of SPECIALS) if (typeof s[r] === "boolean") st[r] = s[r];
    if (s.testRole !== undefined) this.testHostRole = ROLES.includes(s.testRole as Role) ? (s.testRole as Role) : null;
    this.updateListing();
  }

  private setHost(sessionId: string) {
    if (this.state.hostId !== sessionId) this.banned.clear(); // a new host lifts the old host's bans
    this.state.hostId = sessionId;
    this.updateListing();
  }

  // ---- lobby ----

  private handleStartGame(client: Client) {
    if (this.state.phase !== "lobby") return;
    if (client.sessionId !== this.state.hostId) {
      client.send("error", { code: "not_host" });
      return;
    }
    if (this.state.players.size < MIN_PLAYERS) {
      client.send("error", { code: "not_enough_players", min: MIN_PLAYERS });
      return;
    }
    // A 10-second countdown everyone sees; joining closes now (onAuth), spectators still welcome.
    this.state.phase = "starting";
    this.logEvent("starting");
    this.setPhaseTimer(STEP_MS, () => this.beginGame());
    this.updateListing();
  }

  private handleCancelStart(client: Client) {
    if (this.state.phase !== "starting" || client.sessionId !== this.state.hostId) return;
    this.backToLobby("host");
  }

  private backToLobby(reason: "host" | "players") {
    this.phaseTimer?.clear();
    this.state.phase = "lobby";
    this.state.phaseEndsAt = 0;
    this.logEvent("start_cancelled", { reason });
    this.updateListing();
  }

  private beginGame() {
    if (this.state.players.size < MIN_PLAYERS) return this.backToLobby("players"); // people left during the countdown
    // The waiting-room log is over; the game's log starts fresh.
    this.publicLog = [];
    this.gameStartedAt = Date.now();
    this.privateLogs.clear();
    this.chatLog = [];
    this.broadcast("events", []);
    this.assignRoles();
    this.dealTime = DEAL_MS;
    this.startNight();
    this.updateListing();
  }

  private assignRoles() {
    const ids = [...this.state.players.keys()];
    const st = this.state;
    const mix = { werewolf: st.wolves, villager: st.villagers } as Composition;
    for (const r of SPECIALS) mix[r] = st[r];
    const deck = buildDeck(mix, ids.length);

    // TEST ONLY: give the host the role they picked when creating the room.
    const hostId = this.state.hostId;
    if (this.testHostRole && deck.includes(this.testHostRole)) {
      deck.splice(deck.indexOf(this.testHostRole), 1);
      this.roles.set(hostId, this.testHostRole);
      ids.splice(ids.indexOf(hostId), 1);
    }

    shuffle(deck);
    ids.forEach((id, i) => this.roles.set(id, deck[i]));
    const dealt: Record<string, number> = {};
    for (const role of this.roles.values()) dealt[role] = (dealt[role] ?? 0) + 1;
    this.state.dealt = JSON.stringify(dealt);
    const witch = this.idsWithRole("witch")[0];
    if (witch) this.potions.set(witch, { revive: true, poison: true });

    const pack = this.idsWithRole("werewolf").map((id) => this.nameOf(id));
    for (const [id, role] of this.roles) {
      this.sendRole(id, true);
      this.logEvent("your_role", role === "werewolf" ? { role, pack } : { role }, id);
    }
  }

  /** [fresh]: the deal itself (the app plays the card-reveal animation), not a re-send after a reconnect. */
  private sendRole(sessionId: string, fresh = false) {
    const role = this.roles.get(sessionId);
    if (!role) return;
    const pack = role === "werewolf" ? this.idsWithRole("werewolf") : undefined;
    this.clients.getById(sessionId)?.send("role_assigned", { role, fresh, ...(pack ? { pack } : {}) });
  }

  /** The protector learns from the server who he can't protect tonight (survives app relaunches). */
  private sendProtectorTurn(protectorId: string) {
    this.clients.getById(protectorId)?.send("protector_turn", { blocked: this.lastProtected });
  }

  // ---- night: wild hunter (odd nights) → protector → wolves → witch + seer + detective (+ triple face) ----

  private startNight() {
    this.state.dayNumber += 1;
    this.state.phase = "night";
    this.trapTarget = null;
    this.lastProtected = this.protectTarget;
    this.protectTarget = null;
    this.wolfVotes.clear();
    this.wolfTarget = null;
    this.wolfVictim = null;
    this.awake.clear();
    this.witchActors.clear();
    this.reviving = false;
    this.poisons.clear();
    this.logEvent("night", { day: this.state.dayNumber });
    this.startWildHunterStep();
  }

  /** Nights 1, 3, 5…: the Wild Hunter sets his trap on someone (not himself) before anyone else wakes. */
  private startWildHunterStep() {
    if (!this.aliveWithRole("wildhunter") || this.state.dayNumber % 2 === 0) return this.startProtectorStep();
    this.state.nightStep = "wild_hunter";
    this.state.nightRoles = "wildhunter";
    this.logEvent("step", { role: "wildhunter" });
    this.setStepTimer( () => this.startProtectorStep());
  }

  private handleTrap(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "wild_hunter" || !this.actorIs(client, "wildhunter")) return;
    if (!this.isAlive(msg?.targetId) || msg.targetId === client.sessionId) return;
    this.trapTarget = msg.targetId;
    this.logEvent("trapped", { name: this.nameOf(msg.targetId) }, client.sessionId);
    this.startProtectorStep();
  }

  private startProtectorStep() {
    const protector = this.aliveWithRole("protector");
    if (!protector) return this.startWolvesStep();
    this.state.nightStep = "protector";
    this.state.nightRoles = "protector";
    this.logEvent("step", { role: "protector" });
    this.sendProtectorTurn(protector);
    this.setStepTimer( () => this.startWolvesStep());
  }

  private handleProtect(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "protector" || !this.actorIs(client, "protector")) return;
    if (!this.isAlive(msg?.targetId)) return;
    if (msg.targetId === this.lastProtected) {
      client.send("error", { code: "same_protect" });
      return;
    }
    this.protectTarget = msg.targetId;
    this.logEvent("protected", { name: this.nameOf(msg.targetId) }, client.sessionId); // his confirmation
    this.startWolvesStep();
  }

  private startWolvesStep() {
    this.state.nightStep = "wolves";
    this.state.nightRoles = "werewolf";
    this.logEvent("step", { role: "werewolf" });
    this.setStepTimer( () => this.endWolvesStep());
  }

  /** Wolves vote for any living player — packmates too — and may change their vote until the step ends. */
  private handleWolfTarget(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "wolves" || !this.actorIs(client, "werewolf")) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.wolfVotes.set(client.sessionId, msg.targetId);
    const votes = Object.fromEntries(this.wolfVotes);
    for (const id of this.idsWithRole("werewolf")) this.clients.getById(id)?.send("wolf_votes", votes);
  }

  private endWolvesStep() {
    let victim: string | null;
    if (this.wolfVotes.size === 0) {
      // TEST ONLY: wolves that didn't pick anyone kill a random villager.
      const prey = [...this.state.players.keys()].filter((id) => this.isAlive(id) && this.roles.get(id) !== "werewolf");
      victim = prey.length ? prey[Math.floor(Math.random() * prey.length)] : null;
    } else {
      victim = topVoted(this.wolfVotes.values()); // null on a tie
    }
    this.wolfTarget = victim;
    let bitten = victim && victim !== this.protectTarget ? victim : null;
    // Red Hood: the wolves can't touch her during the first 3 nights, as long as the hunter lives.
    if (bitten && this.roles.get(bitten) === "redhood" && this.state.dayNumber <= 3 && this.aliveWithRole("hunter")) {
      bitten = null;
    }
    this.wolfVictim = bitten;
    this.startWitchSeerStep();
  }

  /**
   * The witch (while she has a potion), the seer and the detective wake together. The triple face wakes
   * with them as a second seer on night 1 and as a second witch (with both potions) on night 2.
   */
  private startWitchSeerStep() {
    const day = this.state.dayNumber;
    const tripleFace = this.aliveWithRole("tripleface");
    if (tripleFace && day === 2) this.potions.set(tripleFace, { revive: true, poison: true });
    const witches = [this.aliveWithRole("witch"), day === 2 ? tripleFace : undefined];
    this.witchActors = new Set(witches.filter((id): id is string => !!id && this.hasPotion(id)));
    const detective = this.aliveWithRole("detective");
    const others = [this.aliveWithRole("seer"), day === 1 ? tripleFace : undefined, this.canInvestigate(detective)];
    this.awake = new Set([...this.witchActors, ...others.filter((id): id is string => !!id)]);
    if (this.awake.size === 0) return this.resolveNight();

    this.state.nightStep = "witch_seer";
    this.state.nightRoles = [...this.awake].map((id) => this.roles.get(id)).join(",");
    for (const id of this.awake) {
      const role = this.roles.get(id);
      this.logEvent("step", role === "tripleface" ? { role, as: day === 1 ? "seer" : "witch" } : { role });
    }
    for (const id of this.witchActors) this.sendWitchTurn(id);
    this.setPhaseTimer(STEP_MS, () => this.resolveNight());
  }

  private hasPotion(id: string): boolean {
    const p = this.potions.get(id);
    return !!p && (p.revive || p.poison);
  }

  private sendWitchTurn(witchId: string) {
    const p = this.potions.get(witchId)!;
    const canRevive = p.revive && !this.reviving && this.wolfVictim !== null;
    this.clients.getById(witchId)?.send("witch_turn", {
      victim: canRevive ? this.wolfVictim : null,
      canPoison: p.poison,
    });
  }

  /** Awake in the witch/seer step and still to act. */
  private awakeActor(client: Client): string | null {
    const id = client.sessionId;
    return this.state.nightStep === "witch_seer" && this.awake.has(id) && this.isAlive(id) ? id : null;
  }

  private handleSeerPeek(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const role = id && this.roles.get(id);
    if (!id || !(role === "seer" || (role === "tripleface" && this.state.dayNumber === 1))) return;
    if (!this.isAlive(msg?.targetId) || msg.targetId === id) return;
    this.awake.delete(id);
    const seen = this.roles.get(msg.targetId);
    if (seen) this.known.set(id, { ...this.known.get(id), [msg.targetId]: seen });
    client.send("seer_result", { targetId: msg.targetId, role: seen, isWerewolf: seen === "werewolf" });
    this.logEvent("seer_saw", { name: this.nameOf(msg.targetId), role: seen }, id);
    this.maybeEndWitchSeer();
  }

  /** The detective wakes only while two living players (not him) are still unchecked. */
  private canInvestigate(detective: string | undefined): string | undefined {
    if (!detective) return undefined;
    const fresh = [...this.state.players.keys()].filter(
      (id) => id !== detective && this.isAlive(id) && !this.detectiveChecked.has(id),
    );
    return fresh.length >= 2 ? detective : undefined;
  }

  /** Two players (not himself, never checked before): same team or not. */
  private handleDetective(client: Client, msg: { a: string; b: string }) {
    const id = this.awakeActor(client);
    if (!id || this.roles.get(id) !== "detective") return;
    const { a, b } = msg ?? {};
    if (!this.isAlive(a) || !this.isAlive(b) || a === b || a === id || b === id) return;
    if (this.detectiveChecked.has(a) || this.detectiveChecked.has(b)) {
      client.send("error", { code: "already_checked" });
      return;
    }
    this.detectiveChecked.add(a).add(b);
    const same = (this.roles.get(a) === "werewolf") === (this.roles.get(b) === "werewolf");
    const check = { a, b, same };
    this.detectiveKnown.push(check);
    client.send("detective_result", check);
    this.logEvent("detective_saw", { a: this.nameOf(a), b: this.nameOf(b), same }, id);
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  private witchActor(client: Client): string | null {
    const id = this.awakeActor(client);
    return id && this.witchActors.has(id) ? id : null;
  }

  private handleWitchRevive(client: Client) {
    const id = this.witchActor(client);
    const p = id && this.potions.get(id);
    if (!id || !p || !p.revive || !this.wolfVictim || this.reviving) return;
    p.revive = false;
    this.reviving = true;
    this.logEvent("witch_revived", { name: this.nameOf(this.wolfVictim) }, id);
    this.finishWitchIfNothingLeft(id);
  }

  private handleWitchPoison(client: Client, msg: { targetId: string }) {
    const id = this.witchActor(client);
    const p = id && this.potions.get(id);
    if (!id || !p || !p.poison || !this.isAlive(msg?.targetId)) return; // she may poison herself
    p.poison = false;
    this.poisons.set(id, msg.targetId);
    this.finishWitchIfNothingLeft(id);
  }

  private handleWitchPass(client: Client) {
    const id = this.witchActor(client);
    if (!id) return;
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  private finishWitchIfNothingLeft(id: string) {
    const p = this.potions.get(id)!;
    const canStillRevive = p.revive && !this.reviving && this.wolfVictim !== null;
    if (!canStillRevive && !p.poison) this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  private maybeEndWitchSeer() {
    if (this.awake.size === 0) this.resolveNight();
  }

  private resolveNight() {
    const deaths = new Map<string, DeathCause>();
    const trap = this.trapTarget;
    if (this.wolfVictim && !this.reviving && this.wolfVictim !== trap) deaths.set(this.wolfVictim, "wolves");
    // The trap: a wolf who went for the trapped player dies instead — unless a witch revived him.
    if (trap && this.wolfTarget === trap && !this.reviving) {
      const voters = [...this.wolfVotes].filter(([w, t]) => t === trap && this.isAlive(w)).map(([w]) => w);
      const pool = voters.length ? voters : this.idsWithRole("werewolf").filter((w) => this.isAlive(w)); // TEST random victim
      if (pool.length) deaths.set(pickRandom(pool), "trap");
    }
    // Poisoning the trapped player kills the poisoner instead.
    for (const [poisoner, target] of this.poisons) {
      const [dead, cause]: [string, DeathCause] = target === trap ? [poisoner, "trap"] : [target, "witch"];
      if (!deaths.has(dead)) deaths.set(dead, cause);
    }
    for (const [id, cause] of deaths) this.kill(id, cause);

    this.state.nightStep = "";
    this.state.nightRoles = "";
    this.broadcast("night_result", { deaths: [...deaths.keys()], saved: this.reviving });
    if (this.reviving) this.logEvent("witch_saved");
    this.logEvent("night_result", {
      deaths: [...deaths].map(([id, cause]) => ({ name: this.nameOf(id), role: this.roles.get(id), cause })),
    });
    if (this.endGameIfOver()) return;
    // The village elects its mayor once, after the first night.
    this.afterDeaths(() => (this.mayorElected ? this.startDay() : this.startMayorVote()));
  }

  /**
   * After deaths: wait for the clients' card reveals, then each dead hunter shoots, then a dead mayor
   * names a successor; then [next] runs.
   */
  private afterDeaths(next: () => void): void {
    if (this.revealsPending > 0) {
      const ms = this.revealsPending * REVEAL_MS;
      this.revealsPending = 0;
      this.state.phase = "reveal";
      this.setPhaseTimer(ms, () => this.afterDeaths(next));
      return;
    }
    const shooter = this.pendingShooters.shift();
    if (shooter) return this.startHunterShot(shooter, next);
    const from = this.pendingSuccession;
    this.pendingSuccession = null;
    if (!from) return next();
    this.state.phase = "succession";
    this.state.successionFrom = from;
    this.logEvent("succession", { name: this.nameOf(from) });
    this.afterSuccession = next;
    this.setPhaseTimer(STEP_MS, () => this.endSuccession(null));
  }

  private afterSuccession: () => void = () => {};
  private afterShot: () => void = () => {};

  /**
   * A dead hunter takes someone with him: aimed at random already, he has 10s to aim elsewhere and
   * shoot. Everyone sees where he's aiming (state.shooterAim); at the end of the 10s that one is shot.
   */
  private startHunterShot(hunterId: string, next: () => void): void {
    const prey = [...this.state.players.keys()].filter((id) => this.isAlive(id) && id !== hunterId);
    if (!prey.length) return this.afterDeaths(next);
    this.afterShot = next;
    this.state.phase = "hunter";
    this.state.shooterId = hunterId;
    this.state.shooterAim = pickRandom(prey);
    this.logEvent("hunter_turn", { name: this.nameOf(hunterId) });
    this.setPhaseTimer(STEP_MS, () => this.endHunterShot());
  }

  private handleHunterAim(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "hunter" || client.sessionId !== this.state.shooterId) return;
    if (this.isAlive(msg?.targetId)) this.state.shooterAim = msg.targetId;
  }

  private handleHunterShoot(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "hunter" || client.sessionId !== this.state.shooterId) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.state.shooterAim = msg.targetId;
    this.endHunterShot();
  }

  private endHunterShot() {
    const target = this.state.shooterAim;
    this.state.shooterAim = "";
    this.state.shooterId = "";
    if (target && this.isAlive(target)) {
      this.kill(target, "hunter");
      this.logEvent("hunter_shot", { name: this.nameOf(target), role: this.roles.get(target) });
    }
    if (this.endGameIfOver()) return;
    this.afterDeaths(this.afterShot);
  }

  private handleSuccessor(client: Client, msg: { targetId: string } | null) {
    if (this.state.phase !== "succession" || client.sessionId !== this.state.successionFrom) return;
    if (msg && !this.isAlive(msg.targetId)) return;
    this.endSuccession(msg?.targetId ?? null);
  }

  /** A null successor (pass or timeout) leaves the village without a mayor for the rest of the game. */
  private endSuccession(successor: string | null) {
    this.state.mayorId = successor ?? "";
    this.state.successionFrom = "";
    this.broadcast("mayor_result", { mayorId: successor, successor: true });
    this.logEvent("mayor", { name: this.nameOf(successor), successor: true });
    this.afterSuccession();
  }

  // ---- mayor election, day discussion, exclusion vote ----

  private startMayorVote() {
    this.state.phase = "mayor";
    this.clearVotes();
    this.logEvent("mayor_election");
    this.setPhaseTimer(STEP_MS, () => this.resolveMayor());
  }

  private resolveMayor() {
    const top = topCandidates(this.aliveVotes(1));
    const mayor = top.length ? top[Math.floor(Math.random() * top.length)] : ""; // ties are drawn at random
    this.state.mayorId = mayor;
    this.mayorElected = true;
    this.broadcast("mayor_result", { mayorId: mayor || null });
    this.logEvent("mayor", { name: this.nameOf(mayor), successor: false });
    this.startDay();
  }

  private startDay() {
    this.state.phase = "day";
    this.logEvent("day", { day: this.state.dayNumber });
    this.bearSniffs();
    this.setPhaseTimer(this.state.roundSeconds * 1000, () => this.startVote());
  }

  /** At daybreak the bear roars if a wolf sits next to him (the nearest living player on each side). */
  private bearSniffs() {
    const bear = this.aliveWithRole("bear");
    if (!bear) return;
    const seats = [...this.state.players.keys()].filter((id) => this.isAlive(id));
    const i = seats.indexOf(bear);
    const n = seats.length;
    const neighbours = [seats[(i + 1) % n], seats[(i - 1 + n) % n]];
    if (neighbours.some((id) => id !== bear && this.roles.get(id) === "werewolf")) this.logEvent("bear_roar");
  }

  private startVote() {
    this.state.phase = "vote";
    this.clearVotes();
    this.logEvent("vote_start");
    this.setPhaseTimer(STEP_MS, () => this.resolveVote());
  }

  private clearVotes() {
    for (const p of this.state.players.values()) p.votedFor = "";
  }

  /** Every living player's vote; the mayor's counts [mayorWeight] times. */
  private aliveVotes(mayorWeight: number): string[] {
    const votes: string[] = [];
    for (const [id, p] of this.state.players) {
      if (!p.alive || !p.votedFor) continue;
      for (let i = 0; i < (id === this.state.mayorId ? mayorWeight : 1); i++) votes.push(p.votedFor);
    }
    return votes;
  }

  private handleDayVote(client: Client, msg: { targetId: string }) {
    const phase = this.state.phase;
    if (phase !== "vote" && phase !== "mayor") return;
    const voter = this.state.players.get(client.sessionId);
    if (!voter?.alive) return;
    if (!this.isAlive(msg?.targetId)) return; // voting for yourself is allowed
    voter.votedFor = msg.targetId;

    let voted = 0;
    for (const p of this.state.players.values()) if (p.alive && p.votedFor) voted++;
    if (voted < this.aliveCount()) return;
    if (phase === "mayor") this.resolveMayor();
    else this.resolveVote();
  }

  private resolveVote() {
    const votes = this.aliveVotes(2);
    const excluded = topVoted(votes); // ponytail: a tie skips elimination; add a runoff vote if that feels unsatisfying
    const bestCount = excluded ? votes.filter((v) => v === excluded).length : 0;

    const voters = this.aliveCount() + (this.isAlive(this.state.mayorId) ? 1 : 0);
    if (excluded) this.kill(excluded, "vote");

    const ballots: Record<string, string> = {};
    for (const [id, p] of this.state.players) if (p.votedFor && (p.alive || id === excluded)) ballots[id] = p.votedFor;
    const record: VoteRecord = { day: this.state.dayNumber, excluded, ballots, mayorId: this.state.mayorId };
    this.voteHistory.push(record);

    this.broadcast("vote_result", { ...record, votes: bestCount, voters });
    this.logEvent("vote_result", { name: this.nameOf(excluded), role: excluded ? this.roles.get(excluded) : null });
    if (!this.endGameIfOver()) this.afterDeaths(() => this.startNight());
  }

  // ---- chat ----

  private handleChat(client: Client, msg: { text: string }) {
    const player = this.state.players.get(client.sessionId);
    const text = typeof msg?.text === "string" ? msg.text.trim().slice(0, CHAT_MAX) : "";
    if (!player || !text) return;

    const phase = this.state.phase;
    const open = phase === "lobby" || phase === "gameover";
    if (!open && !player.alive) return;

    const payload: ChatLine = { from: client.sessionId, name: player.name, text, wolvesOnly: phase === "night" };
    if (phase !== "night") {
      this.chatLog.push(payload);
      this.broadcast("chat", payload);
      return;
    }
    // At night only the pack talks, and only to itself.
    if (this.roles.get(client.sessionId) !== "werewolf") return;
    this.wolfChatLog.push(payload);
    for (const id of this.idsWithRole("werewolf")) this.clients.getById(id)?.send("chat", payload);
  }

  // ---- shared helpers ----

  private actorIs(client: Client, role: Role): boolean {
    return this.state.phase === "night" && this.roles.get(client.sessionId) === role && this.isAlive(client.sessionId);
  }

  private idsWithRole(role: Role): string[] {
    return [...this.roles].filter(([, r]) => r === role).map(([id]) => id);
  }

  private aliveWithRole(role: Role): string | undefined {
    return this.idsWithRole(role).find((id) => this.isAlive(id));
  }

  /**
   * Every death goes through here: the app plays a card reveal for each death_reveal. A hunter killed
   * in play (not by leaving) shoots once the reveals are over; his own app skips his reveal.
   */
  private kill(sessionId: string, cause: DeathCause) {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    player.alive = false;
    player.revealedRole = this.roles.get(sessionId) ?? "";
    const inPlay = cause !== "quit" && cause !== "timeout";
    const shooter = inPlay && this.isHunter(sessionId);
    this.broadcast("death_reveal", { id: sessionId, name: player.name, role: player.revealedRole, cause, shooter });
    if (inPlay) this.revealsPending++;
    if (shooter) this.pendingShooters.push(sessionId);
    if (this.state.mayorId === sessionId) {
      this.state.mayorId = "";
      this.pendingSuccession = sessionId;
    }
  }

  /** The hunter — and the triple face from night 3 on. */
  private isHunter(id: string): boolean {
    const role = this.roles.get(id);
    return role === "hunter" || (role === "tripleface" && this.state.dayNumber >= 3);
  }

  private isAlive(sessionId: string | undefined): boolean {
    return !!sessionId && this.state.players.get(sessionId)?.alive === true;
  }

  private aliveCount(): number {
    let count = 0;
    for (const p of this.state.players.values()) if (p.alive) count++;
    return count;
  }

  private endGameIfOver(): boolean {
    let wolvesAlive = 0;
    let othersAlive = 0;
    for (const [id, player] of this.state.players) {
      if (!player.alive) continue;
      if (this.roles.get(id) === "werewolf") wolvesAlive++;
      else othersAlive++;
    }

    if (wolvesAlive === 0) {
      this.endGame("villagers");
      return true;
    }
    // Wolves need every villager dead: a witch with potions can still win a 1-v-1.
    if (othersAlive === 0) {
      this.endGame("werewolves");
      return true;
    }
    return false;
  }

  /** A null winner means the room ran out of time: nobody wins. The room then closes after a visible 60s. */
  private endGame(winner: "werewolves" | "villagers" | null) {
    this.state.phase = "gameover";
    this.state.nightStep = "";
    this.state.nightRoles = "";
    this.state.winner = winner ?? "none";
    this.state.shooterId = "";
    this.state.shooterAim = "";
    this.phaseTimer?.clear();
    for (const [id, player] of this.state.players) player.revealedRole = this.roles.get(id) ?? "";
    this.broadcast("game_over", { winner, reason: winner ? "win" : "expired" });
    this.logEvent("game_over", { winner, reason: winner ? "win" : "expired" });
    if (winner) this.awardResults(winner); // an expired room counts for nobody
    this.state.phaseEndsAt = Date.now() + CLOSE_AFTER_GAME_MS; // clients count down to the room closing
    this.closeTimer ??= this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
    this.updateListing();
  }

  /**
   * Each signed-in player's result: his side won or lost (leaving while alive is a loss), over the
   * whole minutes played since the deal (at least 1). Written to his account; he's told his reward.
   */
  private awardResults(winner: "werewolves" | "villagers") {
    const now = Date.now();
    const results: GameResult[] = [];
    for (const [id, uid] of this.accounts) {
      const role = this.roles.get(id);
      if (!role) continue; // joined the lobby but never got a role
      const left = this.quitAlive.get(id);
      const minutes = Math.max(1, Math.floor(((left ?? now) - this.gameStartedAt) / 60_000));
      const won = left === undefined && (role === "werewolf") === (winner === "werewolves");
      results.push({ uid, role, won, minutes });
      const { xp, coins } = rewardFor({ uid, role, won, minutes });
      this.logEvent("reward", { won, xp, coins, minutes }, id);
    }
    this.lastResults = results;
    recordResults(results).catch((e) => console.error("recording results failed", e));
  }

  private lastResults: GameResult[] = []; // for tests

  /** A night step's timer; the game's first one also covers the card deal animation. */
  private setStepTimer(onExpire: () => void) {
    this.setPhaseTimer(STEP_MS + this.dealTime, onExpire);
    this.dealTime = 0;
  }

  private setPhaseTimer(ms: number, onExpire: () => void) {
    this.phaseTimer?.clear();
    this.state.phaseEndsAt = Date.now() + ms;
    this.phaseTimer = this.clock.setTimeout(onExpire, ms);
  }
}

/**
 * Roles for [players] seats. Fewer players than planned: drop villagers, then specials (DROP_ORDER),
 * then extra wolves. More players than planned: the extras are villagers.
 */
function buildDeck(c: Composition, players: number): Role[] {
  let { werewolf, villager } = c;
  const specials: Role[] = SPECIALS.filter((r) => c[r]);
  let extra = werewolf + villager + specials.length - players;
  for (; extra > 0 && villager > 0; extra--) villager--;
  for (const r of DROP_ORDER) {
    if (extra > 0 && specials.includes(r)) {
      specials.splice(specials.indexOf(r), 1);
      extra--;
    }
  }
  for (; extra > 0 && werewolf > 1; extra--) werewolf--;
  villager += Math.max(0, -extra);
  return [...Array<Role>(werewolf).fill("werewolf"), ...specials, ...Array<Role>(villager).fill("villager")];
}

/** Every target sharing the highest vote count (empty when nobody voted). */
function topCandidates(votes: Iterable<string>): string[] {
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
  const best = Math.max(0, ...tally.values());
  return [...tally].filter(([, count]) => count === best && best > 0).map(([target]) => target);
}

/** The single most-voted target, or null when nobody voted or the top is tied. */
function topVoted(votes: Iterable<string>): string | null {
  const top = topCandidates(votes);
  return top.length === 1 ? top[0] : null;
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
