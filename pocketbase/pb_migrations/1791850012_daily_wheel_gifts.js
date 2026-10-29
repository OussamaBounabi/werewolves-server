/**
 * The home's daily reward and lucky wheel (src/daily.ts), and the store's free coins and gifts. users.daily: the day of
 * the seven last taken, when, and days in a row ({ day, at, streak }); users.wheel: today's free spins used ({ day,
 * used }); users.boostUntil: the wheel's 2x XP, until then; users.storeGift: the day the store's free coins were taken.
 * users.achievements: the ids of the achievements whose prize he claimed (src/achievements.ts).
 * The app reads them on the profile; only the game server writes them (users.updateRule). notices: a "gift" kind (who
 * gave what, and their words, in data).
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "daily", maxSize: 200 }));
  users.fields.add(new JSONField({ name: "wheel", maxSize: 200 }));
  users.fields.add(new DateField({ name: "boostUntil" }));
  users.fields.add(new TextField({ name: "storeGift", max: 20 }));
  users.fields.add(new JSONField({ name: "achievements", maxSize: 1000 }));
  app.save(users);
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift"];
  app.save(notices);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  for (const name of ["daily", "wheel", "boostUntil", "storeGift", "achievements"]) users.fields.removeByName(name);
  app.save(users);
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems"];
  app.save(notices);
});
