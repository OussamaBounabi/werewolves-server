import assert from "assert";
import { addResult, RECENT_GAMES, type GameResult } from "../src/accounts.js";

const game = (over: Partial<GameResult>): GameResult => ({ uid: "u", won: true, minutes: 10, name: "A", avatar: 0, frame: 0, ...over });

describe("stats", () => {
  it("counts every game: totals, per game, Werewolf's sides and roles, the streak and the last games", () => {
    // An account from before: only Werewolf's numbers.
    let s = addResult({ games: 4, wins: 3, losses: 1, minutes: 40 }, game({ game: "domino", minutes: 12 }), 36, 1000);
    assert.deepStrictEqual(s.byGame, { werewolf: { games: 4, wins: 3, minutes: 40 }, domino: { games: 1, wins: 1, minutes: 12 } });
    assert.deepStrictEqual([s.games, s.wins, s.losses, s.minutes], [5, 4, 1, 52]);
    assert.strictEqual(s.roles, undefined); // a table game has no role
    s = addResult(s, game({ role: "seer", side: "village", minutes: 5 }), 15, 2000);
    assert.deepStrictEqual([s.byGame.werewolf.games, s.villageGames, s.roles.seer.wins], [5, 1, 1]);
    assert.deepStrictEqual([s.streak, s.bestStreak], [2, 2]);
    s = addResult(s, game({ game: "chess", won: false }), 10, 3000);
    assert.deepStrictEqual([s.streak, s.bestStreak, s.losses], [0, 2, 2]);
    assert.deepStrictEqual(s.recent[0], { game: "chess", won: false, minutes: 10, xp: 10, at: 3000 });
    assert.deepStrictEqual(s.recent.map((r: any) => r.game), ["chess", "werewolf", "domino"]);
    for (let i = 0; i < 20; i++) s = addResult(s, game({ game: "ludo" }));
    assert.strictEqual(s.recent.length, RECENT_GAMES);
  });
});
