/**
 * Finished chess games (src/chessGames.ts), written by the game server for the app's "My games" and the analysis
 * board: white's and black's accounts ("" a bot or a guest) and names, the moves (UCI, ["e2e4", …]), the result
 * ("1-0", "0-1", "1/2-1/2") and how it ended, the clock. Each player reads his own games only.
 */
migrate((app) => {
  const mine = "white = @request.auth.id || black = @request.auth.id";
  const text = (name, max) => ({ name, type: "text", max });
  app.save(new Collection({
    type: "base",
    name: "chess_games",
    fields: [
      text("white", 40), text("black", 40), text("whiteName", 40), text("blackName", 40),
      { name: "moves", type: "json", maxSize: 20000 },
      text("result", 8), text("reason", 20),
      { name: "minutes", type: "number", min: 0, onlyInt: true },
      { name: "increment", type: "number", min: 0, onlyInt: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE INDEX idx_chess_games_white ON chess_games (white, created)",
      "CREATE INDEX idx_chess_games_black ON chess_games (black, created)",
    ],
    listRule: mine,
    viewRule: mine,
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("chess_games"));
});
