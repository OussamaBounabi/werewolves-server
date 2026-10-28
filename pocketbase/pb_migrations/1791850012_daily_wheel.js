/**
 * The home's daily reward and lucky wheel (src/daily.ts). users.daily: the day of the seven last taken, when, and days
 * in a row ({ day, at, streak }); users.wheel: today's free spins used ({ day, used }); users.boostUntil: the wheel's
 * 2× XP, until then. The app reads them on the profile; only the game server writes them (users.updateRule).
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "daily", maxSize: 200 }));
  users.fields.add(new JSONField({ name: "wheel", maxSize: 200 }));
  users.fields.add(new DateField({ name: "boostUntil" }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  for (const name of ["daily", "wheel", "boostUntil"]) users.fields.removeByName(name);
  app.save(users);
});
