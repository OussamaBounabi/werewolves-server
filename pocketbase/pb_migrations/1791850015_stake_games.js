/**
 * Playing for coins (src/stakes.ts): one row per staked game, written by the game server, read by the admin app
 * (through the server): the game and room, the stake, the pot, the house's cut (%), how it ended (won, draw, cup,
 * refund) and each player's coins in and out ([{ id, name, paid, got, left }]). Nobody else reads them.
 */
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "stake_games",
    fields: [
      { name: "game", type: "text", required: true, max: 20 },
      { name: "room", type: "text", max: 40 },
      { name: "amount", type: "number", min: 0, onlyInt: true },
      { name: "pot", type: "number", min: 0, onlyInt: true },
      { name: "cut", type: "number", min: 0, onlyInt: true },
      { name: "result", type: "select", required: true, maxSelect: 1, values: ["won", "draw", "cup", "refund"] },
      { name: "players", type: "json", maxSize: 4000 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: ["CREATE INDEX idx_stake_games_created ON stake_games (created)"],
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("stake_games"));
});
