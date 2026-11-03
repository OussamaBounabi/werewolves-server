/**
 * The round of 2026-11-02.
 * - clans.coins / diamonds: the clan's wallet (the weekly chest and ranking go in; the leader gives it out). Only the game
 *   server writes them, as every clan field.
 * - clan_wallet: what went in and out, for every member to read. Only the game server writes it.
 * - clan_messages: voice messages (kind "voice": seconds, wave, a protected file, as a friend chat's), replyTo (the line a
 *   new one answers), reactions ({ user: emoji }, the game server's). A member's own "room" lines stay the server's.
 * - users.roleCardUsed: the Master cards a VIP played on roleCardDay.
 * - notices: "clanPay", the leader gave him something from the wallet.
 */
const CREATE_BEFORE_VOICE = [
  '@request.auth.clan != ""',
  "@request.body.clan = @request.auth.clan",
  "@request.body.user = @request.auth.id",
  '@request.body.kind = "text"',
  "@request.body.data:isset = false",
].join(" && ");

migrate((app) => {
  const clans = app.findCollectionByNameOrId("clans");
  clans.fields.add(new NumberField({ name: "coins", onlyInt: true, min: 0 }));
  clans.fields.add(new NumberField({ name: "diamonds", onlyInt: true, min: 0 }));
  app.save(clans);

  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new NumberField({ name: "roleCardUsed", onlyInt: true, min: 0 }));
  app.save(users);

  const myClan = '@request.auth.clan != "" && clan = @request.auth.clan';
  app.save(new Collection({
    type: "base",
    name: "clan_wallet",
    fields: [
      { name: "clan", type: "relation", required: true, collectionId: clans.id, maxSelect: 1, cascadeDelete: true },
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["week", "pay"] },
      { name: "coins", type: "number", onlyInt: true }, // + in, − out
      { name: "diamonds", type: "number", onlyInt: true },
      { name: "user", type: "relation", collectionId: users.id, maxSelect: 1, cascadeDelete: false }, // pay: to whom
      { name: "note", type: "text", max: 100 }, // week: which one
      { name: "rank", type: "number", onlyInt: true }, // week: the clan's place
      { name: "players", type: "number", onlyInt: true }, // week: the members who played
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: ["CREATE INDEX idx_clan_wallet_clan ON clan_wallet (clan, created)"],
    listRule: myClan,
    viewRule: myClan,
  }));

  const lines = app.findCollectionByNameOrId("clan_messages");
  lines.fields.add(new TextField({ name: "replyTo", max: 36, pattern: "^[A-Za-z0-9]*$" }));
  lines.fields.add(new NumberField({ name: "seconds", onlyInt: true, min: 0, max: 60 }));
  lines.fields.add(new TextField({ name: "wave", max: 64, pattern: "^[0-9]*$" }));
  lines.fields.add(new FileField({ name: "voice", maxSelect: 1, maxSize: 614400, protected: true }));
  lines.fields.add(new JSONField({ name: "reactions", maxSize: 4000 }));
  lines.fields.getByName("kind").values = ["text", "voice", "room", "joined", "left", "leader"];
  lines.createRule = [
    '@request.auth.clan != ""',
    "@request.body.clan = @request.auth.clan",
    "@request.body.user = @request.auth.id",
    '(@request.body.kind = "text" || @request.body.kind = "voice")',
    "@request.body.data:isset = false",
    "@request.body.reactions:isset = false",
    '(@request.body.kind != "voice" || (@request.body.seconds >= 1 && @request.body.voice:isset = true))',
    '(@request.body.kind = "voice" || @request.body.voice:isset = false)',
  ].join(" && ");
  app.save(lines);

  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift", "clanInvite", "clanChest", "clanPay"];
  app.save(notices);
}, (app) => {
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift", "clanInvite", "clanChest"];
  app.save(notices);

  const lines = app.findCollectionByNameOrId("clan_messages");
  lines.createRule = CREATE_BEFORE_VOICE;
  for (const name of ["replyTo", "seconds", "wave", "voice", "reactions"]) lines.fields.removeByName(name);
  lines.fields.getByName("kind").values = ["text", "room", "joined", "left", "leader"];
  app.save(lines);

  app.delete(app.findCollectionByNameOrId("clan_wallet"));

  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("roleCardUsed");
  app.save(users);

  const clans = app.findCollectionByNameOrId("clans");
  for (const name of ["coins", "diamonds"]) clans.fields.removeByName(name);
  app.save(clans);
});
