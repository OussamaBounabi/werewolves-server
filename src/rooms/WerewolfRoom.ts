import { Room, Client } from "colyseus";
import { WerewolfState, PlayerState } from "./schema/WerewolfState.js";

type Role = "werewolf" | "villager" | "seer" | "witch";
type Meta = { title: string; host: string; started: boolean };

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 16;
const NIGHT_MS = 45_000;
const DAY_MS = 60_000;
const VOTE_MS = 30_000;
const CHAT_MAX = 200;

export class WerewolfRoom extends Room<{ state: WerewolfState; metadata: Meta }> {
  maxClients = MAX_PLAYERS;
  state = new WerewolfState();

  // Server-only — never synced to clients, so role/night info can't leak.
  private roles = new Map<string, Role>();
  private wolfTargets = new Map<string, string>(); // wolf sessionId -> target sessionId
  private witchSaveUsed = false;
  private witchKillUsed = false;
  private witchSaving = false; // saves whoever the wolves end up choosing
  private witchKillTarget: string | null = null;
  private seerPeekedThisNight = new Set<string>();
  private phaseTimer: { clear(): void } | null = null;
  private lastSnapshot = "";

  // The Flutter client reads state from this plain message instead of Colyseus's
  // binary patches (the native Dart SDK can't resolve hostnames on Android).
  onBeforePatch() {
    const snapshot = this.state.toJSON();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshot) return;
    this.lastSnapshot = json;
    this.broadcast("state", { ...snapshot, serverNow: Date.now() });
  }

  onCreate(options: { title?: string; maxPlayers?: number } = {}) {
    this.maxClients = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(Number(options.maxPlayers) || MAX_PLAYERS)));
    this.setMatchmaking({
      metadata: { title: String(options.title ?? "").trim().slice(0, 32) || "Salon du village", host: "", started: false },
    });

    this.onMessage("start_game", (client) => this.handleStartGame(client));
    this.onMessage("wolf_target", (client, msg: { targetId: string }) => this.handleWolfTarget(client, msg));
    this.onMessage("witch_save", (client) => this.handleWitchSave(client));
    this.onMessage("witch_kill", (client, msg: { targetId: string }) => this.handleWitchKill(client, msg));
    this.onMessage("seer_peek", (client, msg: { targetId: string }) => this.handleSeerPeek(client, msg));
    this.onMessage("day_vote", (client, msg: { targetId: string }) => this.handleDayVote(client, msg));
    this.onMessage("chat", (client, msg: { text: string }) => this.handleChat(client, msg));
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    const name = String(options.name ?? "").trim().slice(0, 24) || `Joueur-${client.sessionId.slice(0, 4)}`;
    this.state.players.set(client.sessionId, new PlayerState({ sessionId: client.sessionId, name }));
    if (!this.state.hostId) this.setHost(client.sessionId);
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
      // ponytail: mid-game disconnects stay seated (connected=false) so vote
      // tallies / role counts don't shift underneath the game loop.
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
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    const wolfCount = Math.max(1, Math.floor(ids.length / 4));
    const pack = ids.slice(0, wolfCount);
    ids.forEach((id, i) => {
      const role: Role = i < wolfCount ? "werewolf" : i === wolfCount ? "seer" : i === wolfCount + 1 ? "witch" : "villager";
      this.roles.set(id, role);
      this.clients.getById(id)?.send("role_assigned", role === "werewolf" ? { role, pack } : { role });
    });
  }

  // ---- night ----

  private startNight() {
    this.state.dayNumber += 1;
    this.state.phase = "night";
    this.wolfTargets.clear();
    this.seerPeekedThisNight.clear();
    this.witchSaving = false;
    this.witchKillTarget = null;
    this.setPhaseTimer(NIGHT_MS, () => this.resolveNight());
  }

  private handleWolfTarget(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "night") return;
    if (this.roles.get(client.sessionId) !== "werewolf" || !this.isAlive(client.sessionId)) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.wolfTargets.set(client.sessionId, msg.targetId);
  }

  private handleWitchSave(client: Client) {
    if (this.state.phase !== "night" || this.witchSaveUsed) return;
    if (this.roles.get(client.sessionId) !== "witch" || !this.isAlive(client.sessionId)) return;
    this.witchSaving = true;
  }

  private handleWitchKill(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "night" || this.witchKillUsed) return;
    if (this.roles.get(client.sessionId) !== "witch" || !this.isAlive(client.sessionId)) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.witchKillTarget = msg.targetId;
  }

  private handleSeerPeek(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "night") return;
    if (this.roles.get(client.sessionId) !== "seer" || !this.isAlive(client.sessionId)) return;
    if (this.seerPeekedThisNight.has(client.sessionId)) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.seerPeekedThisNight.add(client.sessionId);
    client.send("seer_result", {
      targetId: msg.targetId,
      isWerewolf: this.roles.get(msg.targetId) === "werewolf",
    });
  }

  /** Target with the most wolf votes (ties break to whoever was voted first). */
  private currentWolfTarget(): string | null {
    const tally = new Map<string, number>();
    for (const target of this.wolfTargets.values()) tally.set(target, (tally.get(target) ?? 0) + 1);
    let best: string | null = null;
    let bestCount = 0;
    for (const [target, count] of tally) {
      if (count > bestCount) {
        best = target;
        bestCount = count;
      }
    }
    return best;
  }

  private resolveNight() {
    const wolfTarget = this.currentWolfTarget();
    const deaths = new Set<string>();
    let saved: string | null = null;

    if (wolfTarget) {
      if (this.witchSaving) {
        saved = wolfTarget;
        this.witchSaveUsed = true;
      } else {
        deaths.add(wolfTarget);
      }
    }
    if (this.witchKillTarget) {
      deaths.add(this.witchKillTarget);
      this.witchKillUsed = true;
    }

    for (const id of deaths) this.kill(id);

    this.broadcast("night_result", { deaths: [...deaths], saved: saved !== null });

    if (!this.endGameIfOver()) this.startDay();
  }

  // ---- day discussion + vote ----

  private startDay() {
    this.state.phase = "day";
    this.setPhaseTimer(DAY_MS, () => this.startVote());
  }

  private startVote() {
    this.state.phase = "vote";
    for (const p of this.state.players.values()) p.votedFor = "";
    this.setPhaseTimer(VOTE_MS, () => this.resolveVote());
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
    const tally = new Map<string, number>();
    for (const p of this.state.players.values()) {
      if (p.alive && p.votedFor) tally.set(p.votedFor, (tally.get(p.votedFor) ?? 0) + 1);
    }

    let excluded: string | null = null;
    let bestCount = 0;
    let tied = false;
    for (const [target, count] of tally) {
      if (count > bestCount) {
        excluded = target;
        bestCount = count;
        tied = false;
      } else if (count === bestCount) {
        tied = true; // ponytail: a tie skips elimination; add a runoff vote if that feels unsatisfying
      }
    }
    if (tied) excluded = null;

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
    for (const [id, role] of this.roles) {
      if (role === "werewolf") this.clients.getById(id)?.send("chat", payload);
    }
  }

  // ---- shared helpers ----

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
