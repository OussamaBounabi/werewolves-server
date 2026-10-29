/**
 * Clans' weeks (src/clans.ts, accounts.recordResult): the points each clan made this week (its members' game XP while
 * in it) and each member's share, for the weekly chest, the clan ranking and its prizes. Written by the game server;
 * any signed-in player reads them (the ranking; a clan's members and their shares).
 * - clan_weeks: id `<clan>_<week>`.
 * - clan_scores: id `<clan>_<user>_<week>` (a player who changes clan in a week has a row in each).
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const clans = app.findCollectionByNameOrId("clans");
  const signedIn = '@request.auth.id != ""';
  const id = { name: "id", type: "text", primaryKey: true, required: true, system: true, min: 1, max: 64, pattern: "^[A-Za-z0-9_-]+$", autogeneratePattern: "[a-z0-9]{15}" };
  const week = { name: "week", type: "text", required: true, pattern: "^w-[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
  const clan = { name: "clan", type: "relation", required: true, collectionId: clans.id, maxSelect: 1, cascadeDelete: true };
  const points = { name: "points", type: "number", min: 0, onlyInt: true };
  app.save(new Collection({
    type: "base",
    name: "clan_weeks",
    fields: [id, clan, week, points],
    indexes: ["CREATE INDEX idx_clan_weeks_week ON clan_weeks (week, points)"],
    listRule: signedIn,
    viewRule: signedIn,
  }));
  app.save(new Collection({
    type: "base",
    name: "clan_scores",
    fields: [id, clan, { name: "user", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true }, week, points],
    indexes: ["CREATE INDEX idx_clan_scores_clan ON clan_scores (clan, week)"],
    listRule: signedIn,
    viewRule: signedIn,
  }));
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift", "clanInvite", "clanChest"];
  app.save(notices);
}, (app) => {
  for (const name of ["clan_scores", "clan_weeks"]) app.delete(app.findCollectionByNameOrId(name));
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift", "clanInvite"];
  app.save(notices);
});
