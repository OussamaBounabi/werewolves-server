/**
 * The admin app's round of 2026-10-31. Only the game server reads and writes these (no rules: superusers only), but
 * clan_weeks, which the apps read.
 * - admin_log: every change the owner or a moderator made (who, what, to whom, the details).
 * - game_log: one row per finished game (the players, who won, how long); uids: their ids, for a player's history.
 * - wallet_log: each change of a player's coins and diamonds, and where it came from (game, wheel, store…).
 * - crashes: the apps' errors, one row per error and version (id: its hash), counted.
 * - reports: handled (support dealt with it), snapshot (the chat around it, the room's or the friend chat's, kept
 *   by the server soon after the report), picture (Mystery Item's reported picture), snapped (the server looked).
 * - clans.noRanking: out of the clan ranking (the apps don't list its weeks; no prizes).
 * - users.lang (the app's language) and users.lastSeen (the day his app last opened), for targeted notifications.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const created = { name: "created", type: "autodate", onCreate: true, onUpdate: false };
  app.save(new Collection({
    type: "base",
    name: "admin_log",
    fields: [
      { name: "who", type: "text", max: 40 },
      { name: "email", type: "text", max: 120 },
      { name: "role", type: "text", max: 20 },
      { name: "action", type: "text", max: 60 },
      { name: "target", type: "text", max: 60 },
      { name: "details", type: "json", maxSize: 4000 },
      created,
    ],
    indexes: ["CREATE INDEX idx_admin_log_created ON admin_log (created)", "CREATE INDEX idx_admin_log_target ON admin_log (target)"],
  }));
  app.save(new Collection({
    type: "base",
    name: "game_log",
    fields: [
      { name: "game", type: "text", required: true, max: 20 },
      { name: "minutes", type: "number", min: 0, onlyInt: true },
      { name: "players", type: "json", maxSize: 4000 },
      { name: "uids", type: "text", max: 2000 },
      created,
    ],
    indexes: ["CREATE INDEX idx_game_log_created ON game_log (created)", "CREATE INDEX idx_game_log_game ON game_log (game, created)"],
  }));
  app.save(new Collection({
    type: "base",
    name: "wallet_log",
    fields: [
      { name: "user", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "coins", type: "number", onlyInt: true },
      { name: "diamonds", type: "number", onlyInt: true },
      { name: "source", type: "text", required: true, max: 20 },
      { name: "note", type: "text", max: 100 },
      created,
    ],
    indexes: ["CREATE INDEX idx_wallet_log_user ON wallet_log (user, created)", "CREATE INDEX idx_wallet_log_created ON wallet_log (created)"],
  }));
  app.save(new Collection({
    type: "base",
    name: "crashes",
    fields: [
      { name: "id", type: "text", primaryKey: true, required: true, system: true, min: 1, max: 40, pattern: "^[a-z0-9]+$", autogeneratePattern: "[a-z0-9]{15}" },
      { name: "message", type: "text", max: 500 },
      { name: "stack", type: "text", max: 4000 },
      { name: "version", type: "text", max: 20 },
      { name: "count", type: "number", min: 0, onlyInt: true },
      { name: "last", type: "text", max: 40 }, // the uid of the last player it happened to
      created,
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_crashes_updated ON crashes (updated)"],
  }));

  const reports = app.findCollectionByNameOrId("reports");
  reports.fields.add(new BoolField({ name: "handled" }));
  reports.fields.add(new BoolField({ name: "snapped" }));
  reports.fields.add(new JSONField({ name: "snapshot", maxSize: 20000 }));
  reports.fields.add(new FileField({ name: "picture", maxSelect: 1, maxSize: 300000, mimeTypes: ["image/jpeg", "image/png", "image/webp"] }));
  app.save(reports);

  const clans = app.findCollectionByNameOrId("clans");
  clans.fields.add(new BoolField({ name: "noRanking" }));
  app.save(clans);
  const weeks = app.findCollectionByNameOrId("clan_weeks");
  weeks.listRule = weeks.viewRule = '@request.auth.id != "" && clan.noRanking != true';
  app.save(weeks);

  users.fields.add(new TextField({ name: "lang", max: 2 }));
  users.fields.add(new TextField({ name: "lastSeen", max: 10 }));
  app.save(users);
}, (app) => {
  for (const name of ["admin_log", "game_log", "wallet_log", "crashes"]) app.delete(app.findCollectionByNameOrId(name));
  const reports = app.findCollectionByNameOrId("reports");
  for (const name of ["handled", "snapped", "snapshot", "picture"]) reports.fields.removeByName(name);
  app.save(reports);
  const weeks = app.findCollectionByNameOrId("clan_weeks");
  weeks.listRule = weeks.viewRule = '@request.auth.id != ""';
  app.save(weeks);
  const clans = app.findCollectionByNameOrId("clans");
  clans.fields.removeByName("noRanking");
  app.save(clans);
  const users = app.findCollectionByNameOrId("users");
  for (const name of ["lang", "lastSeen"]) users.fields.removeByName(name);
  app.save(users);
});
