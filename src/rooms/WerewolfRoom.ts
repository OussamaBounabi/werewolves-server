import { Room, Client } from "colyseus";
import { WerewolfState, PlayerState } from "./schema/WerewolfState.js";

type Role = "werewolf" | "villager" | "seer" | "witch" | "protector";
type Meta = { title: string; host: string; started: boolean };

const ROLES: readonly Role[] = ["werewolf", "villager", "seer", "witch", "protector"];
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 16;
const STEP_MS = 10_000; // every phase and every night step
const RECONNECT_SECONDS = 60;
const CHAT_MAX = 200;

export class WerewolfRoom extends Room<{ state: WerewolfState; metadata: Meta }> {
  maxClients = MAX_PLAYERS;
  state = new WerewolfState();

  // Server-only — never synced to clients, so role/night info can't leak.
  private roles = new Map<string, Role>();
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

  // The Flutter client reads state from this plain message instead of Colyseus's binary patches.
  onBeforePatch() {
    const snapshot = this.state.toJSON();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshot) return;
    this.lastSnapshot = json;
    this.broadcast("state", { ...snapshot, serverNow: Date.now() });
  }

  onCreate(options: { title?: string; maxPlayers?: number; testRole?: string } = {}) {
    this.maxClients = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(Number(options.maxPlayers) || MAX_PLAYERS)));
    this.testHostRole = ROLES.includes(options.testRole as Role) ? (options.testRole as Role) : null;
    this.setMatchmaking({
      metadata: { title: String(options.title ?? "").trim().slice(0, 32) || "Village", host: "", started: false },
    });

    this.onMessage("start_game", (client) => this.handleStartGame(client));
    this.onMessage("protect", (client, msg: { targetId: string }) => this.handleProtect(client, msg));
    this.onMessage("wolf_target", (client, msg: { targetId: string }) => this.handleWolfTarget(client, msg));
    this.onMessage("seer_peek", (client, msg: { targetId: string }) => this.handleSeerPeek(client, msg));
    this.onMessage("witch_revive", (client) => this.handleWitchRevive(client));
    this.onMessage("witch_poison", (client, msg: { targetId: string }) => this.handleWitchPoison(client, msg));
    this.onMessage("witch_pass", (client) => this.handleWitchPass(client));
    this.onMessage("day_vote", (client, msg: { targetId: string }) => this.handleDayVote(client, msg));
    this.onMessage("chat", (client, msg: { text: string }) => this.handleChat(client, msg));
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    const name = String(options.name ?? "").trim().slice(0, 24) || `Player-${client.sessionId.slice(0, 4)}`;
    this.state.players.set(client.sessionId, new PlayerState({ sessionId: client.sessionId, name }));
    if (!this.state.hostId) this.setHost(client.sessionId);
  }

  // Network drop: keep the seat so the app can reconnect.
  onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    // Rejects if the seat expires (onLeave then runs) or the client never finished joining.
    Promise.resolve(this.allowReconnection(client, RECONNECT_SECONDS)).catch(() => {});
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    // Private messages sent while disconnected are lost; send what the player needs again.
    this.sendRole(client.sessionId);
    if (this.state.nightStep === "witch_seer" && this.roles.get(client.sessionId) === "witch" && !this.witchDone) {
      this.sendWitchTurn(client.sessionId);
    }
    client.send("state", { ...this.state.toJSON(), serverNow: Date.now() });
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
      if (this.state.hostId === client.sessionId) {
        const next = this.state.players.keys().next().value;
        this.setHost(next ?? "");
      }
    } else {
      // Seat stays so votes and role counts don't shift mid-game.
      player.connected = false;
    }
  }

  private setHost(sessionId: string) {
    this.state.hostId = sessionId;
    const host = this.state.players.get(sessionId)?.name ?? "";
    this.setMatchmaking({ metadata: { ...this.metadata, host } });
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
    this.setMatchmaking({ locked: true, metadata: { ...this.metadata, started: true } });
    this.assignRoles();
    this.startNight();
  }

  private assignRoles() {
    const ids = [...this.state.players.keys()];
    const wolfCount = Math.max(1, Math.floor(ids.length / 4));
    const deck: Role[] = [
      ...Array<Role>(wolfCount).fill("werewolf"),
      "seer",
      "witch",
      "protector",
      ...Array<Role>(Math.max(0, ids.length - wolfCount - 3)).fill("villager"),
    ];

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
    this.setPhaseTimer(STEP_MS, () => this.startWolvesStep());
  }

  private handleProtect(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "protector" || !this.actorIs(client, "protector")) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.protectTarget = msg.targetId;
    this.startWolvesStep();
  }

  private startWolvesStep() {
    this.state.nightStep = "wolves";
    this.setPhaseTimer(STEP_MS, () => this.endWolvesStep());
  }

  private handleWolfTarget(client: Client, msg: { targetId: string }) {
    if (this.state.nightStep !== "wolves" || !this.actorIs(client, "werewolf")) return;
    if (!this.isAlive(msg?.targetId) || this.roles.get(msg.targetId) === "werewolf") return;
    this.wolfVotes.set(client.sessionId, msg.targetId);
    const wolves = this.idsWithRole("werewolf").filter((id) => this.isAlive(id));
    if (wolves.every((id) => this.wolfVotes.has(id))) this.endWolvesStep();
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
    const witch = this.aliveWithRole("witch");
    const seer = this.aliveWithRole("seer");
    if (!witch && !seer) return this.resolveNight();
    this.state.nightStep = "witch_seer";
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
    client.send("seer_result", { targetId: msg.targetId, isWerewolf: this.roles.get(msg.targetId) === "werewolf" });
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
    if (this.witchPoisonUsed || !this.isAlive(msg?.targetId) || msg.targetId === client.sessionId) return;
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
    this.broadcast("night_result", { deaths: [...deaths], saved: this.witchReviving });
    if (!this.endGameIfOver()) this.startDay();
  }

  // ---- day discussion + vote ----

  private startDay() {
    this.state.phase = "day";
    this.setPhaseTimer(STEP_MS, () => this.startVote());
  }

  private startVote() {
    this.state.phase = "vote";
    for (const p of this.state.players.values()) p.votedFor = "";
    this.setPhaseTimer(STEP_MS, () => this.resolveVote());
  }

  private handleDayVote(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "vote") return;
    const voter = this.state.players.get(client.sessionId);
    if (!voter?.alive) return;
    if (!this.isAlive(msg?.targetId)) return;
    voter.votedFor = msg.targetId;

    let voted = 0;
    for (const p of this.state.players.values()) if (p.alive && p.votedFor) voted++;
    if (voted >= this.aliveCount()) this.resolveVote();
  }

  private resolveVote() {
    const votes: string[] = [];
    for (const p of this.state.players.values()) if (p.alive && p.votedFor) votes.push(p.votedFor);
    const excluded = topVoted(votes); // ponytail: a tie skips elimination; add a runoff vote if that feels unsatisfying
    const bestCount = excluded ? votes.filter((v) => v === excluded).length : 0;

    const voters = this.aliveCount();
    if (excluded) this.kill(excluded);

    this.broadcast("vote_result", { excluded, votes: bestCount, voters, day: this.state.dayNumber });
    if (!this.endGameIfOver()) this.startNight();
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
    if (othersAlive <= wolvesAlive) {
      this.endGame("werewolves");
      return true;
    }
    return false;
  }

  private endGame(winner: "werewolves" | "villagers") {
    this.state.phase = "gameover";
    this.state.nightStep = "";
    this.state.winner = winner;
    this.state.phaseEndsAt = 0;
    this.phaseTimer?.clear();
    for (const [id, player] of this.state.players) player.revealedRole = this.roles.get(id) ?? "";
    this.broadcast("game_over", { winner });
  }

  private setPhaseTimer(ms: number, onExpire: () => void) {
    this.phaseTimer?.clear();
    this.state.phaseEndsAt = Date.now() + ms;
    this.phaseTimer = this.clock.setTimeout(onExpire, ms);
  }
}

/** The single most-voted target, or null when nobody voted or the top is tied. */
function topVoted(votes: Iterable<string>): string | null {
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [target, count] of tally) {
    if (count > bestCount) [best, bestCount, tied] = [target, count, false];
    else if (count === bestCount) tied = true;
  }
  return tied ? null : best;
}

function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
