/**
 * - users.appVersion: the version of the app each player last opened ("1.0.7"), written by the game server
 *   at his token exchange, so the owner sees who is still on an old one. Hidden: superusers only.
 * - announcements: messages from support to every player, in Arabic, English and French. The game server
 *   writes them for an admin; signed-in players read them, and the apps show the newest one, once.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new TextField({ name: "appVersion", max: 20, hidden: true }));
  app.save(users);

  const signedIn = '@request.auth.id != ""';
  const text = (name) => ({ name, type: "text", max: 1000 });
  app.save(new Collection({
    type: "base",
    name: "announcements",
    fields: [text("ar"), text("en"), text("fr"), { name: "created", type: "autodate", onCreate: true }],
    indexes: ["CREATE INDEX idx_announcements_created ON announcements (created)"],
    listRule: signedIn,
    viewRule: signedIn,
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("announcements"));
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("appVersion");
  app.save(users);
});
