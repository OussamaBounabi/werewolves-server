/**
 * Clans (src/clans.ts). Everything is written by the game server, except a member's own chat lines.
 * - clans: name and tag (each once), motto, emblem (shape, color: one of the app's eight), who may join (open,
 *   request, closed) and from which level, its XP (its members' game XP; the level comes from it), how many members,
 *   the leaders' pinned line. Any signed-in player sees them (the search, the ranking).
 * - clan_members: who is in which clan, with his role (leader, co-leader, elder, member); one clan each.
 * - clan_requests: players asking to join a clan that asks for requests; the player and the clan's members see them.
 * - clan_invites: a member's invitation to a friend; it lets him in past "request" (not past full or the level).
 * - clan_messages: the clan's chat: members' lines (they write their own "text"), and the server's (a room a member
 *   opened, with { roomId, game }; someone joined, left, a new leader).
 * - users.clan: his clan; users.clanLeftAt: when he last left one (24 hours before he may join another).
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const signedIn = '@request.auth.id != ""';
  const created = { name: "created", type: "autodate", onCreate: true };
  const player = (name, required = true) => ({
    name, type: "relation", required, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });

  const clans = new Collection({
    type: "base",
    name: "clans",
    fields: [
      { name: "name", type: "text", required: true, min: 3, max: 20 },
      { name: "tag", type: "text", required: true, min: 2, max: 4, pattern: "^[A-Z0-9]+$" },
      { name: "motto", type: "text", max: 40 },
      { name: "shape", type: "select", required: true, maxSelect: 1, values: ["shield", "hexagon", "circle", "star", "bookmark"] },
      { name: "color", type: "number", min: 0, max: 7, onlyInt: true },
      { name: "join", type: "select", required: true, maxSelect: 1, values: ["open", "request", "closed"] },
      { name: "minLevel", type: "number", min: 1, max: 50, onlyInt: true },
      { name: "xp", type: "number", min: 0, onlyInt: true },
      { name: "members", type: "number", min: 0, onlyInt: true },
      { name: "pinned", type: "text", max: 200 },
      created,
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_clans_name ON clans (lower(name))",
      "CREATE UNIQUE INDEX idx_clans_tag ON clans (tag)",
      "CREATE INDEX idx_clans_xp ON clans (xp)",
    ],
    listRule: signedIn,
    viewRule: signedIn,
  });
  app.save(clans);
  // (before the rules that read it)
  users.fields.add(new RelationField({ name: "clan", collectionId: clans.id, maxSelect: 1 }));
  users.fields.add(new DateField({ name: "clanLeftAt" }));
  app.save(users);
  const clan = { name: "clan", type: "relation", required: true, collectionId: clans.id, maxSelect: 1, cascadeDelete: true };

  app.save(new Collection({
    type: "base",
    name: "clan_members",
    fields: [clan, player("user"), { name: "role", type: "select", required: true, maxSelect: 1, values: ["leader", "coLeader", "elder", "member"] }, created],
    indexes: ["CREATE UNIQUE INDEX idx_clan_members_user ON clan_members (user)", "CREATE INDEX idx_clan_members_clan ON clan_members (clan)"],
    listRule: signedIn,
    viewRule: signedIn,
  }));

  const mineOrMyClans = "user = @request.auth.id || clan = @request.auth.clan";
  app.save(new Collection({
    type: "base",
    name: "clan_requests",
    fields: [clan, player("user"), created],
    indexes: ["CREATE UNIQUE INDEX idx_clan_requests ON clan_requests (clan, user)"],
    listRule: mineOrMyClans,
    viewRule: mineOrMyClans,
  }));

  app.save(new Collection({
    type: "base",
    name: "clan_invites",
    fields: [clan, player("user"), player("by"), created],
    indexes: ["CREATE UNIQUE INDEX idx_clan_invites ON clan_invites (clan, user)"],
    listRule: "user = @request.auth.id",
    viewRule: "user = @request.auth.id",
  }));

  const myClan = '@request.auth.clan != "" && clan = @request.auth.clan';
  app.save(new Collection({
    type: "base",
    name: "clan_messages",
    fields: [
      clan,
      player("user", false), // none: the server's line
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["text", "room", "joined", "left", "leader"] },
      { name: "text", type: "text", max: 500 },
      { name: "data", type: "json", maxSize: 500 },
      created,
    ],
    indexes: ["CREATE INDEX idx_clan_messages_clan ON clan_messages (clan, created)"],
    listRule: myClan,
    viewRule: myClan,
    createRule: [
      '@request.auth.clan != ""',
      "@request.body.clan = @request.auth.clan",
      "@request.body.user = @request.auth.id",
      '@request.body.kind = "text"',
      "@request.body.data:isset = false",
    ].join(" && "),
  }));

  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift", "clanInvite"];
  app.save(notices);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  for (const name of ["clan", "clanLeftAt"]) users.fields.removeByName(name);
  app.save(users);
  for (const name of ["clan_messages", "clan_invites", "clan_requests", "clan_members", "clans"]) {
    app.delete(app.findCollectionByNameOrId(name));
  }
  const notices = app.findCollectionByNameOrId("notices");
  notices.fields.getByName("kind").values = ["message", "warning", "reward", "gems", "gift"];
  app.save(notices);
});
