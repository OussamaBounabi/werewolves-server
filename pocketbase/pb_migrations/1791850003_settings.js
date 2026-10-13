/**
 * Batch requests: the apps accept a friend request in one (two friends rows + the request deleted), and
 * the game server writes every reward, purchase and mission claim in one, so it all happens or none of it
 * (and `coins+` style increments inside a batch don't lose updates under load).
 */
migrate((app) => {
  const settings = app.settings();
  settings.batch.enabled = true;
  settings.batch.maxRequests = 100;
  settings.batch.timeout = 10;
  app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.batch.enabled = false;
  app.save(settings);
});
