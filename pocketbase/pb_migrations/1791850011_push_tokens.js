/**
 * users.pushTokens: the player's phones for notifications (Firebase Cloud Messaging tokens, his last 5), so a private
 * message or an invitation reaches him with the app closed (src/push.ts). Hidden: only the game server reads or
 * writes it.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "pushTokens", maxSize: 2000, hidden: true }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("pushTokens");
  app.save(users);
});
