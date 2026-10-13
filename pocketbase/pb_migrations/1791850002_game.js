/**
 * What the game server keeps for each player, and the reports players send:
 * - private_info: his e-mail, how he signs in, his birth date (old accounts). Owner reads.
 * - missions: one row per player and period (day or week), id `<uid>_<period>`. Owner reads.
 * - leaderboard: one row per player and week, id `<uid>_<week>`. Signed-in players read.
 * - presence: online / in_game / offline and which game, id = his uid. Signed-in players read.
 * - reports: one per reporter and target. Nobody reads them but superusers (the dashboard).
 * Only the game server (a superuser) writes the first four; rules can't let a player touch them.
 */

const UID = { pattern: "^[A-Za-z0-9]+$", min: 1, max: 36 };
const id = (spec) => ({
  name: "id", type: "text", primaryKey: true, required: true, system: true, autogeneratePattern: "[a-z0-9]{15}", ...spec,
});

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name) => ({
    name, type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const ownerOnly = "user = @request.auth.id";
  const signedIn = '@request.auth.id != ""';

  app.save(new Collection({
    type: "base",
    name: "private_info",
    fields: [
      id(UID), // = user
      player("user"),
      { name: "email", type: "text", max: 255 },
      { name: "provider", type: "select", maxSelect: 1, values: ["password", "google.com"] },
      { name: "birthDate", type: "text", max: 10, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      { name: "createdAt", type: "date" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_private_info_user ON private_info (user)"],
    listRule: ownerOnly,
    viewRule: ownerOnly,
  }));

  const counter = (name) => ({ name, type: "number", onlyInt: true, min: 0 });
  app.save(new Collection({
    type: "base",
    name: "missions",
    fields: [
      id({ pattern: "^[A-Za-z0-9_-]+$", min: 1, max: 64 }), // <uid>_<period>
      player("user"),
      { name: "period", type: "text", required: true, pattern: "^[dw]-[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      counter("games"), counter("wins"), counter("wolfWins"), counter("villageWins"), counter("survived"), counter("minutes"),
      { name: "claimed", type: "json", maxSize: 5000 }, // { "<mission id>": true }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_missions_user_period ON missions (user, period)"],
    listRule: ownerOnly,
    viewRule: ownerOnly,
  }));

  app.save(new Collection({
    type: "base",
    name: "leaderboard",
    fields: [
      id({ pattern: "^[A-Za-z0-9_-]+$", min: 1, max: 64 }), // <uid>_<week>
      { name: "week", type: "text", required: true, pattern: "^w-[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
      player("user"),
      counter("xp"),
      { name: "name", type: "text", max: 16 }, // his display name then
      { name: "avatar", type: "number", onlyInt: true, min: 0 },
      { name: "frame", type: "number", onlyInt: true, min: 0 },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_leaderboard_week_user ON leaderboard (week, user)",
      "CREATE INDEX idx_leaderboard_week_xp ON leaderboard (week, xp)",
    ],
    listRule: signedIn,
    viewRule: signedIn,
  }));

  app.save(new Collection({
    type: "base",
    name: "presence",
    fields: [
      id(UID), // = user
      player("user"),
      { name: "state", type: "select", required: true, maxSelect: 1, values: ["online", "in_game", "offline"] },
      { name: "game", type: "text", max: 32 }, // the room's name while in_game: werewolf, rummy, domino…
      { name: "at", type: "autodate", onCreate: true, onUpdate: true },
    ],
    listRule: signedIn,
    viewRule: signedIn,
  }));

  app.save(new Collection({
    type: "base",
    name: "reports",
    fields: [
      player("target"),
      player("reporter"),
      { name: "reason", type: "select", required: true, maxSelect: 1, values: ["cheating", "insults", "bad_name", "spam", "afk", "other"] },
      { name: "context", type: "text", max: 100 },
      { name: "firebaseAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_reports_target_reporter ON reports (target, reporter)"], // one each
    createRule: [
      "@request.body.reporter = @request.auth.id",
      "@request.body.target != @request.auth.id",
      "@request.body.firebaseAt:isset = false",
    ].join(" && "),
  }));
}, (app) => {
  for (const name of ["reports", "presence", "leaderboard", "missions", "private_info"]) {
    app.delete(app.findCollectionByNameOrId(name));
  }
});
