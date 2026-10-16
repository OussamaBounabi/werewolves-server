/**
 * The weekly store, VIP and VIP Pro, and the weekly ranking's prizes:
 * - users.vipUntil / vipProUntil: when VIP and VIP Pro end (empty while vip / vipPro is on: for good); the game server
 *   turns the flags off when the date passes. users.roleCardDay: the day a VIP last played the role his Master card
 *   chose (one a day). users.proKicks: { month, used }, a VIP Pro's kicks in rooms he doesn't host (3 a month).
 * - leaderboard.vip: "" | "vip" | "pro", the badge by his name in the ranking.
 * - notices: two more kinds, "reward" (his place in last week's ranking and its prize) and "gems" (VIP's diamonds of
 *   the month), their numbers in `data`: the apps write the text in the player's language.
 * - admin_config: the admin app's plans, one row each: "store" (the weeks' items and prices, VIP Pro's own items,
 *   VIP-only emojis), "missions" (the days' and weeks' missions), "rewards" (the ranking's prizes), and "done" (the
 *   last week rewarded, the last month of VIP diamonds). Superusers only.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new DateField({ name: "vipUntil" }));
  users.fields.add(new DateField({ name: "vipProUntil" }));
  users.fields.add(new TextField({ name: "roleCardDay", max: 20 }));
  users.fields.add(new JSONField({ name: "proKicks", maxSize: 200 }));
  app.save(users);

  const leaderboard = app.findCollectionByNameOrId("leaderboard");
  leaderboard.fields.add(new TextField({ name: "vip", max: 3 }));
  app.save(leaderboard);

  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems"];
  notices.fields.add(new JSONField({ name: "data", maxSize: 2000 }));
  app.save(notices);

  app.save(new Collection({
    type: "base",
    name: "admin_config",
    fields: [
      { name: "id", type: "text", primaryKey: true, required: true, system: true, min: 1, max: 20, pattern: "^[a-z]+$", autogeneratePattern: "" },
      { name: "data", type: "json", maxSize: 2000000 },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("admin_config"));
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.removeByName("data");
  notices.fields.getByName("kind").values = ["message", "warning"];
  app.save(notices);
  const leaderboard = app.findCollectionByNameOrId("leaderboard");
  leaderboard.fields.removeByName("vip");
  app.save(leaderboard);
  const users = app.findCollectionByNameOrId("users");
  for (const name of ["vipUntil", "vipProUntil", "roleCardDay", "proKicks"]) users.fields.removeByName(name);
  app.save(users);
});
