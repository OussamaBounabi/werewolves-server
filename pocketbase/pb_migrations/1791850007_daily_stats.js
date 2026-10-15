/**
 * daily_stats: the app's numbers day by day (Algeria time), for the admin app. The game server keeps them: the games
 * started in each game, who opened the app that day (their ids: the day's active players), and how many players
 * were online every ten minutes. One row a day, id `d20261015`. Superusers only (no rules).
 */
migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "daily_stats",
    fields: [
      { name: "id", type: "text", primaryKey: true, required: true, system: true, min: 9, max: 9, pattern: "^d[0-9]{8}$", autogeneratePattern: "" },
      { name: "day", type: "text", required: true, max: 10 }, // 2026-10-15
      { name: "games", type: "json", maxSize: 5000 }, // { werewolf: 12, ludo: 3, … } games started
      { name: "active", type: "json", maxSize: 2000000 }, // [uid, …] who opened the app
      { name: "online", type: "json", maxSize: 20000 }, // [[minute of the day, players online], …] every ten minutes
      { name: "peak", type: "number", onlyInt: true, min: 0 }, // the most online at once
    ],
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("daily_stats"));
});
