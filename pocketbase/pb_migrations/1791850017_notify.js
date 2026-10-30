/**
 * users.notify: the phone notifications a player turned off ({ clanRooms: false, clanChat: false }; a key missing:
 * on). Only the game server writes it (POST /api/notify; users.updateRule stays null).
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "notify", maxSize: 200 }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("notify");
  app.save(users);
});
