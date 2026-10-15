/**
 * Support, from the admin app:
 * - users.bannedUntil / banReason: an account banned until then (year 9999: for good). users.device: the phone he
 *   last opened the app on (Android's id for this app), written at his token exchange. All hidden: superusers only.
 * - device_bans: a banned phone, every account on it refused at the exchange. Superusers only.
 * - notices: a message or a warning from support to one player. He reads his own and marks them read (all he may
 *   change); the apps show each one until he has.
 * - support_messages: a player's conversation with support. He reads his own and writes his side; the game server
 *   writes support's answers for the admin.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new DateField({ name: "bannedUntil", hidden: true }));
  users.fields.add(new TextField({ name: "banReason", max: 200, hidden: true }));
  users.fields.add(new TextField({ name: "device", max: 64, hidden: true }));
  app.save(users);

  const player = (name) => ({
    name, type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const ownerOnly = "user = @request.auth.id";
  const created = { name: "created", type: "autodate", onCreate: true };

  app.save(new Collection({
    type: "base",
    name: "device_bans",
    fields: [
      { name: "device", type: "text", required: true, min: 1, max: 64 },
      { name: "until", type: "date", required: true },
      { name: "reason", type: "text", max: 200 },
      { name: "user", type: "relation", collectionId: users.id, maxSelect: 1 }, // whose phone it was
      created,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_device_bans_device ON device_bans (device)"],
  }));

  app.save(new Collection({
    type: "base",
    name: "notices",
    fields: [
      player("user"),
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["message", "warning"] },
      { name: "text", type: "text", required: true, min: 1, max: 1000 },
      { name: "readAt", type: "date" },
      created,
    ],
    indexes: ["CREATE INDEX idx_notices_user ON notices (user, created)"],
    listRule: ownerOnly,
    viewRule: ownerOnly,
    updateRule: [
      ownerOnly,
      "@request.body.user:isset = false",
      "@request.body.kind:isset = false",
      "@request.body.text:isset = false",
    ].join(" && "),
  }));

  app.save(new Collection({
    type: "base",
    name: "support_messages",
    fields: [
      player("user"), // whose conversation
      { name: "fromSupport", type: "bool" },
      { name: "text", type: "text", required: true, min: 1, max: 1000 },
      created,
    ],
    indexes: ["CREATE INDEX idx_support_messages_user ON support_messages (user, created)"],
    listRule: ownerOnly,
    viewRule: ownerOnly,
    createRule: ["@request.body.user = @request.auth.id", "@request.body.fromSupport:isset = false"].join(" && "),
  }));
}, (app) => {
  for (const name of ["support_messages", "notices", "device_bans"]) {
    app.delete(app.findCollectionByNameOrId(name));
  }
  const users = app.findCollectionByNameOrId("users");
  for (const name of ["bannedUntil", "banReason", "device"]) users.fields.removeByName(name);
  app.save(users);
});
