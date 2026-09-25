import { Room, Client } from "colyseus";
import { WerewolfState, PlayerState } from "./schema/WerewolfState.js";

type Role = "werewolf" | "villager" | "seer" | "witch";

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 16;
const NIGHT_MS = 45_000;
const DAY_MS = 60_000;
const VOTE_MS = 30_000;

export class WerewolfRoom extends Room<{ state: WerewolfState }> {
  maxClients = MAX_PLAYERS;
  state = new WerewolfState();

  // Server-only — never synced to clients, so role/vote info can't leak.
  private roles = new Map<string, Role>();
  private wolfTargets = new Map<string, string>(); // wolf sessionId -> target sessionId
  private witchSaveUsed = false;
  private witchKillUsed = false;
  private witchSaveTarget: string | null = null;
  private witchKillTarget: string | null = null;
  private seerPeekedThisNight = new Set<string>();
  private dayVotes = new Map<string, string>(); // voter sessionId -> target sessionId
  private phaseTimer: { clear(): void } | null = null;

  onCreate() {
    this.onMessage("start_game", (client) => this.handleStartGame(client));
    this.onMessage("wolf_target", (client, msg: { targetId: string }) => this.handleWolfTarget(client, msg));
    this.onMessage("witch_save", (client) => this.handleWitchSave(client));
    this.onMessage("witch_kill", (client, msg: { targetId: string }) => this.handleWitchKill(client, msg));
    this.onMessage("seer_peek", (client, msg: { targetId: string }) => this.handleSeerPeek(client, msg));
    this.onMessage("day_vote", (client, msg: { targetId: string }) => this.handleDayVote(client, msg));
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    this.state.players.set(
      client.sessionId,
      new PlayerState({
        sessionId: client.sessionId,
        name: options.name?.slice(0, 24) || `Player-${client.sessionId.slice(0, 4)}`,
      })
    );
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (this.state.phase === "lobby") {
      this.state.players.delete(client.sessionId);
    } else {
      // ponytail: mid-game disconnects stay seated (connected=false) rather than
      // being removed, so vote tallies / role counts don't shift underneath the
      // game loop. Reconnect support can restore `connected` later if needed.
      player.connected = false;
    }
  }

  // ---- lobby ----

  private handleStartGame(client: Client) {
    if (this.state.phase !== "lobby") return;
    if (this.state.players.size < MIN_PLAYERS) {
      client.send("error", { message: `Need at least ${MIN_PLAYERS} players.` });
      return;
    }
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
    ids.forEach((id, i) => {
      const role: Role = i < wolfCount ? "werewolf" : i === wolfCount ? "seer" : i === wolfCount + 1 ? "witch" : "villager";
      this.roles.set(id, role);
      this.clients.getById(id)?.send("role_assigned", { role });
    });
  }

  // ---- night ----

  private startNight() {
    this.state.dayNumber += 1;
    this.state.phase = "night";
    this.wolfTargets.clear();
    this.seerPeekedThisNight.clear();
    this.witchSaveTarget = null;
    this.witchKillTarget = null;
    this.setPhaseTimer(NIGHT_MS, () => this.resolveNight());
  }

  private handleWolfTarget(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "night") return;
    if (this.roles.get(client.sessionId) !== "werewolf") return;
    if (!this.isAlive(msg.targetId)) return;
    this.wolfTargets.set(client.sessionId, msg.targetId);
  }

  private handleWitchSave(client: Client) {
    if (this.state.phase !== "night" || this.witchSaveUsed) return;
    if (this.roles.get(client.sessionId) !== "witch") return;
    this.witchSaveTarget = this.currentWolfTarget();
  }

  private handleWitchKill(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "night" || this.witchKillUsed) return;
    if (this.roles.get(client.sessionId) !== "witch") return;
    if (!this.isAlive(msg.targetId)) return;
    this.witchKillTarget = msg.targetId;
  }

  private handleSeerPeek(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "night") return;
    if (this.roles.get(client.sessionId) !== "seer") return;
    if (this.seerPeekedThisNight.has(client.sessionId)) return;
    if (!this.isAlive(msg.targetId)) return;
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

    if (wolfTarget && wolfTarget !== this.witchSaveTarget) deaths.add(wolfTarget);
    if (this.witchKillTarget) {
      deaths.add(this.witchKillTarget);
      this.witchKillUsed = true;
    }
    if (this.witchSaveTarget) this.witchSaveUsed = true;

    for (const id of deaths) {
      const player = this.state.players.get(id);
      if (player) player.alive = false;
    }

    this.broadcast("night_result", { deaths: [...deaths] });

    if (!this.endGameIfOver()) this.startDay();
  }

  // ---- day discussion + vote ----

  private startDay() {
    this.state.phase = "day";
    this.setPhaseTimer(DAY_MS, () => this.startVote());
  }

  private startVote() {
    this.state.phase = "vote";
    this.dayVotes.clear();
    this.setPhaseTimer(VOTE_MS, () => this.resolveVote());
  }

  private handleDayVote(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "vote") return;
    if (!this.isAlive(client.sessionId)) return;
    if (!this.isAlive(msg.targetId)) return;
    this.dayVotes.set(client.sessionId, msg.targetId);

    if (this.dayVotes.size >= this.aliveCount()) this.resolveVote();
  }

  private resolveVote() {
    const tally = new Map<string, number>();
    for (const target of this.dayVotes.values()) tally.set(target, (tally.get(target) ?? 0) + 1);

    let excluded: string | null = null;
    let bestCount = 0;
    let tied = false;
    for (const [target, count] of tally) {
      if (count > bestCount) {
        excluded = target;
        bestCount = count;
        tied = false;
      } else if (count === bestCount && bestCount > 0) {
        tied = true; // ponytail: a tie skips elimination; add a runoff vote if that feels unsatisfying
      }
    }
    if (tied) excluded = null;

    if (excluded) {
      const player = this.state.players.get(excluded);
      if (player) player.alive = false;
    }

    this.broadcast("vote_result", { excluded });

    if (!this.endGameIfOver()) this.startNight();
  }

  // ---- shared helpers ----

  private isAlive(sessionId: string): boolean {
    return this.state.players.get(sessionId)?.alive === true;
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
    if (othersAlive === 0) {
      this.endGame("werewolves");
      return true;
    }
    return false;
  }

  private endGame(winner: "werewolves" | "villagers") {
    this.state.phase = "gameover";
    this.state.winner = winner;
    this.phaseTimer?.clear();
    this.broadcast("game_over", { winner });
  }

  private setPhaseTimer(ms: number, onExpire: () => void) {
    this.phaseTimer?.clear();
    this.state.phaseEndsAt = Date.now() + ms;
    this.phaseTimer = this.clock.setTimeout(onExpire, ms);
  }
}
