import { accountsEnabled, db } from "./accounts.js";

/**
 * Finished chess games, kept for their two players (the app's "My games", the analysis board): who played white and
 * black, the moves (UCI: "e2e4"), the result ("1-0", "0-1", "1/2-1/2") and how it ended, the clock.
 */
export type SavedGame = {
  white: string; black: string; // their accounts ("" a bot or a guest)
  whiteName: string; blackName: string;
  moves: string[];
  result: string;
  reason: string;
  minutes: number; increment: number;
};

export async function saveChessGame(game: SavedGame) {
  if (!accountsEnabled || (!game.white && !game.black) || game.moves.length === 0) return;
  await (await db()).collection("chess_games").create(game);
}
