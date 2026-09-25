import { Room, Client, ServerError } from "colyseus";
import { WerewolfState, PlayerState } from "./schema/WerewolfState.js";

type Role = "werewolf" | "villager" | "seer" | "witch" | "protector";
type Meta = { host: string; started: boolean; players: number; maxPlayers: number; spectators: number };
type JoinOptions = { name?: string; playerId?: string; spectator?: boolean };
type VoteRecord = { day: number; excluded: string | null; ballots: Record<string, string>; mayorId: string };
/** Roles the host picked for the room: counts for wolves/villagers, in-or-out for the rest. */
type Composition = { werewolf: number; villager: number; seer: boolean; witch: boolean; protector: boolean };
/** What the host can change in the lobby (also accepted as create options). */
type Settings = {
  roomType?: string;
  maxPlayers?: number;
  roundSeconds?: number;
  wolves?: number;
  villagers?: number;
  seer?: boolean;
  witch?: boolean;
  protector?: boolean;
  testRole?: string | null;
};
const SPECIALS = ["seer", "witch", "protector"] as const;

const ROLES: readonly Role[] = ["werewolf", "villager", "seer", "witch", "protector"];
const ROOM_TYPES = ["public", "friends", "private"];
const ROUND_OPTIONS = [10, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 30)]; // 10s, 30s … 15min
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const STEP_MS = 10_000; // night steps and votes — TEMPORARY fixed value, the user wants it configurable later
const RECONNECT_SECONDS = 600; // a dropped player's seat is held 10 minutes, then he dies
const ROOM_LIFESPAN_MS = 60 * 60_000; // a room lives at most 1 hour from creation
const MAX_CONNECTIONS = 100; // players + spectators; the player limit is maxPlayers, checked in onAuth
const CHAT_MAX = 200;

export class WerewolfRoom extends Room<{ state: WerewolfState; metadata: Meta }> {
  maxClients = MAX_CONNECTIONS;
  state = new WerewolfState();

  // Server-only — never synced to clients, so role/night info can't leak.
  private roles = new Map<string, Role>();
  private playerIds = new Map<string, string>(); // sessionId → the device's stable player id
  private banned = new Set<string>(); // player ids kicked by the current host
  private spectators = new Set<string>(); // sessionIds watching, not playing
  private dropped = new Set<string>(); // players whose connection dropped (seat held)
  private heldSeats = new Map<string, { reject: Function }>(); // pending reconnections (Colyseus Deferred)
  private voteHistory: VoteRecord[] = [];
  private seerKnown: Record<string, string> = {}; // what the seer has seen, re-sent after a reconnect
  private testHostRole: Role | null = null; // TEST ONLY: host picks their own role
  private phaseTimer: { clear(): void } | null = null;
  private lastSnapshot = "";

  // Per night
  private protectTarget: string | null = null;
  private wolfVotes = new Map<string, string>(); // wolf -> target
  private wolfVictim: string | null = null; // after protection and ties
  private seerDone = false;
  private witchDone = false;
  private witchReviving = false;
  private witchPoisonTarget: string | null = null;

  // Per game
  private witchReviveUsed = false;
  private witchPoisonUsed = false;
  private lastProtected: string | null = null; // can't be protected two nights in a row
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
    this.onMessage("protect", (client, msg: { targetId: string }) => this.handleProtect(client, msg));
    this.onMessage("wolf_target", (client, msg: { targetId: string }) => this.handleWolfTarget(client, msg));
    this.onMessage("seer_peek", (client, msg: { targetId: string }) => this.handleSeerPeek(client, msg));
    this.onMessage("witch_revive", (client) => this.handleWitchRevive(client));
    this.onMessage("witch_poison", (client, msg: { targetId: string }) => this.handleWitchPoison(client, msg));
    this.onMessage("witch_pass", (client) => this.handleWitchPass(client));
    this.onMessage("day_vote", (client, msg: { targetId: string }) => this.handleDayVote(client, msg));
    this.onMessage("mayor_successor", (client, msg: { targetId: string }) => this.handleSuccessor(client, msg));
    this.onMessage("mayor_pass", (client) => this.handleSuccessor(client, null));
    this.onMessage("chat", (client, msg: { text: string }) => this.handleChat(client, msg));
  }

  /** Runs when the client's socket connects (not on reconnects): bans, spectators, and the player limit. */
  onAuth(_client: Client, options: JoinOptions = {}) {
    if (options.playerId && this.banned.has(String(options.playerId))) throw new ServerError(4403, "banned");
    if (options.spectator) return true;
    if (this.state.phase !== "lobby") throw new ServerError(4409, "started");
    if (this.state.players.size >= this.state.maxPlayers) throw new ServerError(4409, "full");
    return true;
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    client.send("vote_history", this.voteHistory);
    if (options.spectator) {
      this.spectators.add(client.sessionId);
      this.state.spectators = this.spectators.size;
      return this.updateListing();
    }
    const name = String(options.name ?? "").trim().slice(0, 24) || `Player-${client.sessionId.slice(0, 4)}`;
    this.playerIds.set(client.sessionId, String(options.playerId ?? client.sessionId));
    this.state.players.set(client.sessionId, new PlayerState({ sessionId: client.sessionId, name }));
    if (!this.state.hostId) this.setHost(client.sessionId);
    this.updateListing();
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
    if (role === "seer") client.send("seer_known", this.seerKnown);
    if (role === "werewolf" && this.state.nightStep === "wolves") client.send("wolf_votes", Object.fromEntries(this.wolfVotes));
    if (role === "witch" && this.state.nightStep === "witch_seer" && !this.witchDone) this.sendWitchTurn(id);
    client.send("vote_history", this.voteHistory);
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
    if (this.state.phase === "lobby") {
      this.removeFromLobby(id);
    } else if (this.state.phase !== "gameover") {
      // Quitting on purpose is final; a dropped player who never came back dies too.
      player.connected = false;
      this.removeFromGame(id, timedOut ? "timeout" : "quit");
    } else {
      player.connected = false;
    }
    this.updateListing();
  }

  private removeFromLobby(id: string) {
    this.state.players.delete(id);
    this.playerIds.delete(id);
    if (this.state.hostId === id) this.setHost(this.state.players.keys().next().value ?? "");
  }

  /** A player gone for good mid-game dies on the spot, outside any night/vote resolution. */
  private removeFromGame(id: string, reason: "quit" | "timeout") {
    if (!this.isAlive(id)) return;
    this.kill(id);
    this.broadcast("player_gone", { id, reason, role: this.roles.get(id) });
    if (this.pendingSuccession === id) {
      // He isn't here to name a successor: the village has no mayor from now on.
      this.pendingSuccession = null;
      this.broadcast("mayor_result", { mayorId: null, successor: true });
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
    this.removeFromLobby(target);
    this.updateListing();
    kicked?.leave(4000);
  }

  /** The 1-hour limit: an unfinished game ends with no winner, then everyone is sent home. */
  private expire() {
    if (this.state.phase !== "gameover") this.endGame(null);
    this.clock.setTimeout(() => this.disconnect(), 15_000);
  }

  /** What the lobby screen lists for this room. */
  private updateListing() {
    const host = this.state.players.get(this.state.hostId)?.name ?? "";
    this.setMatchmaking({
      maxClients: MAX_CONNECTIONS,
      metadata: {
        host,
        started: this.state.phase !== "lobby",
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
    // The room stays unlocked so spectators can still join; onAuth turns new players away.
    this.assignRoles();
    this.startNight();
    this.updateListing();
  }

  private assignRoles() {
    const ids = [...this.state.players.keys()];
    const st = this.state;
    const mix = { werewolf: st.wolves, villager: st.villagers, seer: st.seer, witch: st.witch, protector: st.protector };
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
    for (const id of this.roles.keys()) this.sendRole(id);
  }

  private sendRole(sessionId: string) {
    const role = this.roles.get(sessionId);
    if (!role) return;
    const pack = role === "werewolf" ? this.idsWithRole("werewolf") : undefined;
    this.clients.getById(sessionId)?.send("role_assigned", pack ? { role, pack } : { role });
  }

  // ---- night: protector → wolves → witch + seer ----

  private startNight() {
    this.state.dayNumber += 1;
    this.state.phase = "night";
    this.lastProtected = this.protectTarget;
    this.protectTarget = null;
    this.wolfVotes.clear();
    this.wolfVictim = null;
    this.seerDone = false;
    this.witchDone = false;
    this.witchReviving = false;
    this.witchPoisonTarget = null;
    this.startProtectorStep();
  }

  private startProtectorStep() {
    if (!this.aliveWithRole("protector")) return this.startWolvesStep();
    this.state.nightStep = "protector";
    this.state.nightRoles = "protector";
    this.setPhaseTimer(STEP_MS, () => this.startWolvesStep());
  }

  private handleProtect(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "protector" || !this.actorIs(client, "protector")) return;
    if (!this.isAlive(msg?.targetId)) return;
    if (msg.targetId === this.lastProtected) {
      client.send("error", { code: "same_protect" });
      return;
    }
    this.protectTarget = msg.targetId;
    this.startWolvesStep();
  }

  private startWolvesStep() {
    this.state.nightStep = "wolves";
    this.state.nightRoles = "werewolf";
    this.setPhaseTimer(STEP_MS, () => this.endWolvesStep());
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
    this.wolfVictim = victim && victim !== this.protectTarget ? victim : null;
    this.startWitchSeerStep();
  }

  private startWitchSeerStep() {
    // The witch only wakes while she still has a potion.
    const witch = !this.witchReviveUsed || !this.witchPoisonUsed ? this.aliveWithRole("witch") : undefined;
    const seer = this.aliveWithRole("seer");
    if (!witch && !seer) return this.resolveNight();
    this.state.nightStep = "witch_seer";
    this.state.nightRoles = [witch && "witch", seer && "seer"].filter(Boolean).join(",");
    this.seerDone = !seer;
    this.witchDone = !witch;
    if (witch) this.sendWitchTurn(witch);
    this.setPhaseTimer(STEP_MS, () => this.resolveNight());
  }

  private sendWitchTurn(witchId: string) {
    const canRevive = !this.witchReviveUsed && !this.witchReviving && this.wolfVictim !== null;
    this.clients.getById(witchId)?.send("witch_turn", {
      victim: canRevive ? this.wolfVictim : null,
      canPoison: !this.witchPoisonUsed,
    });
  }

  private handleSeerPeek(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "witch_seer" || this.seerDone || !this.actorIs(client, "seer")) return;
    if (!this.isAlive(msg?.targetId) || msg.targetId === client.sessionId) return;
    this.seerDone = true;
    const role = this.roles.get(msg.targetId);
    if (role) this.seerKnown[msg.targetId] = role;
    client.send("seer_result", { targetId: msg.targetId, role, isWerewolf: role === "werewolf" });
    this.maybeEndWitchSeer();
  }

  private handleWitchRevive(client: Client) {
    if (this.state.nightStep !== "witch_seer" || this.witchDone || !this.actorIs(client, "witch")) return;
    if (this.witchReviveUsed || !this.wolfVictim) return;
    this.witchReviveUsed = true;
    this.witchReviving = true;
    this.finishWitchIfNothingLeft();
  }

  private handleWitchPoison(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "witch_seer" || this.witchDone || !this.actorIs(client, "witch")) return;
    if (this.witchPoisonUsed || !this.isAlive(msg?.targetId)) return; // she may poison herself
    this.witchPoisonUsed = true;
    this.witchPoisonTarget = msg.targetId;
    this.finishWitchIfNothingLeft();
  }

  private handleWitchPass(client: Client) {
    if (this.state.nightStep !== "witch_seer" || this.witchDone || !this.actorIs(client, "witch")) return;
    this.witchDone = true;
    this.maybeEndWitchSeer();
  }

  private finishWitchIfNothingLeft() {
    const canStillRevive = !this.witchReviveUsed && this.wolfVictim !== null;
    if (!canStillRevive && this.witchPoisonUsed) this.witchDone = true;
    this.maybeEndWitchSeer();
  }

  private maybeEndWitchSeer() {
    if (this.seerDone && this.witchDone) this.resolveNight();
  }

  private resolveNight() {
    const deaths = new Set<string>();
    if (this.wolfVictim && !this.witchReviving) deaths.add(this.wolfVictim);
    if (this.witchPoisonTarget) deaths.add(this.witchPoisonTarget);
    for (const id of deaths) this.kill(id);

    this.state.nightStep = "";
    this.state.nightRoles = "";
    this.broadcast("night_result", { deaths: [...deaths], saved: this.witchReviving });
    if (this.endGameIfOver()) return;
    // The village elects its mayor once, after the first night.
    this.afterDeaths(() => (this.mayorElected ? this.startDay() : this.startMayorVote()));
  }

  /** If the mayor just died, he first gets a turn to name a successor; then [next] runs. */
  private afterDeaths(next: () => void) {
    const from = this.pendingSuccession;
    this.pendingSuccession = null;
    if (!from) return next();
    this.state.phase = "succession";
    this.state.successionFrom = from;
    this.afterSuccession = next;
    this.setPhaseTimer(STEP_MS, () => this.endSuccession(null));
  }

  private afterSuccession: () => void = () => {};

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
    this.afterSuccession();
  }

  // ---- mayor election, day discussion, exclusion vote ----

  private startMayorVote() {
    this.state.phase = "mayor";
    this.clearVotes();
    this.setPhaseTimer(STEP_MS, () => this.resolveMayor());
  }

  private resolveMayor() {
    const top = topCandidates(this.aliveVotes(1));
    const mayor = top.length ? top[Math.floor(Math.random() * top.length)] : ""; // ties are drawn at random
    this.state.mayorId = mayor;
    this.mayorElected = true;
    this.broadcast("mayor_result", { mayorId: mayor || null });
    this.startDay();
  }

  private startDay() {
    this.state.phase = "day";
    this.setPhaseTimer(this.state.roundSeconds * 1000, () => this.startVote());
  }

  private startVote() {
    this.state.phase = "vote";
    this.clearVotes();
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
    if (excluded) this.kill(excluded);

    const ballots: Record<string, string> = {};
    for (const [id, p] of this.state.players) if (p.votedFor && (p.alive || id === excluded)) ballots[id] = p.votedFor;
    const record: VoteRecord = { day: this.state.dayNumber, excluded, ballots, mayorId: this.state.mayorId };
    this.voteHistory.push(record);

    this.broadcast("vote_result", { ...record, votes: bestCount, voters });
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

    const payload = { from: client.sessionId, name: player.name, text, wolvesOnly: phase === "night" };
    if (phase !== "night") {
      this.broadcast("chat", payload);
      return;
    }
    // At night only the pack talks, and only to itself.
    if (this.roles.get(client.sessionId) !== "werewolf") return;
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

  private kill(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    player.alive = false;
    player.revealedRole = this.roles.get(sessionId) ?? "";
    if (this.state.mayorId === sessionId) {
      this.state.mayorId = "";
      this.pendingSuccession = sessionId;
    }
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

  /** A null winner means the room ran out of time: nobody wins. */
  private endGame(winner: "werewolves" | "villagers" | null) {
    this.state.phase = "gameover";
    this.state.nightStep = "";
    this.state.nightRoles = "";
    this.state.winner = winner ?? "none";
    this.state.phaseEndsAt = 0;
    this.phaseTimer?.clear();
    for (const [id, player] of this.state.players) player.revealedRole = this.roles.get(id) ?? "";
    this.broadcast("game_over", { winner, reason: winner ? "win" : "expired" });
    this.updateListing();
  }

  private setPhaseTimer(ms: number, onExpire: () => void) {
    this.phaseTimer?.clear();
    this.state.phaseEndsAt = Date.now() + ms;
    this.phaseTimer = this.clock.setTimeout(onExpire, ms);
  }
}

/**
 * Roles for [players] seats. Fewer players than planned: drop villagers, then protector, witch, seer,
 * then extra wolves. More players than planned: the extras are villagers.
 */
function buildDeck(c: Composition, players: number): Role[] {
  let { werewolf, villager } = c;
  const specials: Role[] = SPECIALS.filter((r) => c[r]);
  let extra = werewolf + villager + specials.length - players;
  for (; extra > 0 && villager > 0; extra--) villager--;
  for (const r of ["protector", "witch", "seer"] as const) {
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

function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
