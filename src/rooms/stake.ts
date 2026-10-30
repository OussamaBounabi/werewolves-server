import { accountsEnabled, type Account } from "../accounts.js";
import { playerLevel } from "../clans.js";
import { nextSlot, type Match } from "../guess.js";
import { pocketWallet, share, stakePlan, type Wallet } from "../stakes.js";

type Player = { playerId: string; name: string };

/**
 * A cup's places from its finished bracket (seat ids): [[champion], [runner-up], [the semi-final losers]] — the
 * semi-finals being the matches that lead into the final. A bye has no loser.
 */
export function cupPlaces(matches: Match[]): string[][] {
  const final = matches.length - 1;
  const loser = (m: Match) => (m.winner === m.a ? m.b : m.a);
  const semis = matches.filter((_, i) => i !== final && nextSlot(matches.length + 1, i)?.match === final);
  return [[matches[final].winner], [loser(matches[final])], semis.map(loser)].map((place) => place.filter(Boolean));
}

/**
 * A table's stake (src/stakes.ts): the level its host picked (0: free), who may sit at it, the pot of the match being
 * played, its payout. A room calls set (settings), joinError (onAuth, a spectator sitting), begin (each match's start),
 * leave (a player gone mid-game), settle (the match's result) and refund (the room closing mid-game). Players are
 * known by their playerId (their account's uid).
 */
export class StakeTable {
  static wallet: Wallet = pocketWallet; // tests: their own
  amount = 0;
  /** The last match's payouts, for the apps' result screens. */
  last: { id: string; name: string; got: number }[] = [];
  private paid = new Map<string, number>(); // playerId → coins in this match's pot
  private names = new Map<string, string>();
  private gone = new Set<string>();
  private busy = false; // the stakes are being taken

  constructor(public game: string, private room: { roomId: string }) {}

  /** The host picks a level (0: free); anything not among the admin's is ignored. */
  set(value: unknown) {
    const n = Number(value);
    if (n === 0 || stakePlan().levels.some((l) => l.amount === n)) this.amount = n;
  }

  private minLevel() {
    return stakePlan().levels.find((l) => l.amount === this.amount)?.minLevel ?? 1;
  }

  /** Why [account] can't sit at this table ("": he can). His coins are taken, and checked again, when the game starts. */
  joinError(account: Account | null): string {
    if (!this.amount) return "";
    if (!account) return accountsEnabled ? "stake_guest" : ""; // (no accounts: the tests and local servers)
    if (playerLevel(account.xp ?? 0) < this.minLevel()) return "stake_level";
    if ((account.coins ?? 0) < this.amount) return "stake_coins";
    return "";
  }

  /**
   * A match starts: everyone's stake into the pot, then [start] (false: it couldn't start after all, everything is
   * given back). One of them can't pay: nobody pays, and [fail] says who. A free table starts at once.
   */
  begin(players: Player[], start: () => boolean | void, fail: (why: { code: string; name: string }) => void): void {
    this.last = [];
    if (!this.amount) return void start();
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      const taken: string[] = [];
      for (const p of players) {
        const ok = await StakeTable.wallet.take(p.playerId, this.amount, this.minLevel()).catch(() => "stake_coins");
        if (ok === "ok") {
          taken.push(p.playerId);
          continue;
        }
        for (const id of taken) await StakeTable.wallet.give(id, this.amount).catch(() => {});
        this.busy = false;
        return fail({ code: ok, name: p.name });
      }
      this.paid = new Map(taken.map((id) => [id, this.amount]));
      this.names = new Map(players.map((p) => [p.playerId, p.name]));
      this.gone.clear();
      this.busy = false;
      if (start() === false) this.refund();
    })();
  }

  /** He left the match: his stake stays in the pot, and he gets nothing from it. */
  leave(playerId: string) {
    if (this.paid.has(playerId)) this.gone.add(playerId);
  }

  /** The match is over: [winners] share the pot (none: a draw, each his own back less the cut). */
  settle(winners: string[]) {
    this.payOut(winners.length ? [winners] : [], false, winners.length ? "won" : "draw");
  }

  /** A cup is over: [[champion], [runner-up], [semi-final losers]]. */
  settleCup(places: string[][]) {
    this.payOut(places, true, "cup");
  }

  /** The room closes before the match ends: those still here get their stake back, whole. */
  refund() {
    if (!this.paid.size) return;
    const back = new Map([...this.paid].filter(([id]) => !this.gone.has(id)));
    this.pay(back, "refund");
  }

  private payOut(places: string[][], cup: boolean, result: string) {
    if (!this.paid.size) return;
    const present = new Set([...this.paid.keys()].filter((id) => !this.gone.has(id)));
    this.pay(share(this.paid, present, places, stakePlan().cut, cup), result);
  }

  private pay(got: Map<string, number>, result: string) {
    const paid = this.paid;
    this.paid = new Map();
    this.last = [...paid.keys()].map((id) => ({ id, name: this.names.get(id) ?? "", got: got.get(id) ?? 0 }));
    for (const [id, coins] of got) if (coins > 0) StakeTable.wallet.give(id, coins).catch((e) => console.error(`stake: paying ${id} failed`, e));
    const pot = [...paid.values()].reduce((a, b) => a + b, 0);
    StakeTable.wallet
      .log({
        game: this.game, room: this.room.roomId, amount: this.amount, pot, cut: stakePlan().cut, result,
        players: [...paid].map(([id, n]) => ({ id, name: this.names.get(id) ?? "", paid: n, got: got.get(id) ?? 0, left: this.gone.has(id) })),
      })
      .catch(() => {});
  }
}
