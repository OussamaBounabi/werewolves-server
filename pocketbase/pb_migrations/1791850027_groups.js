/**
 * The Chat tab, phase 3 (2026-11-13): groups of friends, and the clan as a group.
 *
 * groups: a name, an emoji and a colour (the picture is two members' avatars), keep (its messages stay; else they
 * vanish 24 h after they're sent, saved ones aside). group_members: who's in, an admin or not; invited = added by a
 * member, waiting for his yes; each member's own muted, pinned and readAt (his unread count). The game server makes,
 * changes and leaves groups (src/groups.ts: 32 members at most, only friends added, the admin's rights, who becomes
 * admin when one leaves); a member answers his invitation (accept: invited off; decline: his row deleted) and keeps his
 * own settings here. group_messages: written by joined members (text, voice; deleting one's own leaves a mark), the
 * server's lines (type system: data says what happened), reactions and saved marks set through the game server.
 * group_chats: one row per membership of mine, with the group's last line and my unread count.
 * clan_members: readAt and muted, each member's own (the clan's chat in the Chat tab).
 */
const HIDDEN = "('system')";
const VIEW = `
      SELECT
        gm.id AS id,
        gm.user AS user,
        gm.\`group\` AS chat,
        g.name AS name,
        g.emoji AS emoji,
        g.color AS color,
        g.keep AS keep,
        gm.admin AS admin,
        gm.invited AS invited,
        gm.muted AS muted,
        gm.pinned AS pinned,
        m.text AS lastMessage,
        m.\`from\` AS lastFrom,
        m.type AS lastType,
        CAST(COALESCE(m.created, g.created) AS TEXT) AS updatedAt,
        CAST(MIN(99, (
          SELECT COUNT(*) FROM group_messages u
          WHERE u.\`group\` = gm.\`group\` AND COALESCE(u.\`from\`, '') != gm.user AND u.type NOT IN ${HIDDEN}
            AND u.created > COALESCE(gm.readAt, '')
        )) AS INTEGER) AS unread,
        CAST((SELECT COUNT(*) FROM group_members x WHERE x.\`group\` = gm.\`group\` AND x.invited = FALSE) AS INTEGER) AS members
      FROM group_members gm
      JOIN groups g ON g.id = gm.\`group\`
      LEFT JOIN group_messages m ON m.id = (
        SELECT x.id FROM group_messages x
        WHERE x.\`group\` = gm.\`group\` AND x.type NOT IN ${HIDDEN}
        ORDER BY x.created DESC
        LIMIT 1
      )`;

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name, required = true) => ({
    name, type: "relation", required, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const created = { name: "created", type: "autodate", onCreate: true };

  const groups = new Collection({
    type: "base",
    name: "groups",
    fields: [
      { name: "name", type: "text", required: true, min: 1, max: 40 },
      { name: "emoji", type: "text", max: 16 },
      { name: "color", type: "number", onlyInt: true, min: 0, max: 7 },
      { name: "keep", type: "bool" },
      created,
    ],
  });
  app.save(groups);
  const group = { name: "group", type: "relation", required: true, collectionId: groups.id, maxSelect: 1, cascadeDelete: true };

  const members = new Collection({
    type: "base",
    name: "group_members",
    fields: [
      group,
      player("user"),
      { name: "admin", type: "bool" },
      { name: "invited", type: "bool" },
      player("by", false), // who added him
      { name: "muted", type: "bool" },
      { name: "pinned", type: "bool" },
      { name: "readAt", type: "date" },
      created,
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_group_members_pair ON group_members (`group`, user)",
      "CREATE INDEX idx_group_members_user ON group_members (user)",
    ],
  });
  app.save(members);
  const inMine = "group.group_members_via_group.user ?= @request.auth.id";
  members.listRule = `user = @request.auth.id || ${inMine}`;
  members.viewRule = members.listRule;
  // His own row: his settings, and his yes to an invitation; nothing else.
  members.updateRule = [
    "user = @request.auth.id",
    ...["group", "user", "admin", "by"].map((f) => `@request.body.${f}:isset = false`),
    "(@request.body.invited:isset = false || (invited = true && @request.body.invited = false))",
  ].join(" && ");
  members.deleteRule = "user = @request.auth.id && invited = true"; // an invitation declined
  app.save(members);

  groups.listRule = "group_members_via_group.user ?= @request.auth.id";
  groups.viewRule = groups.listRule;
  app.save(groups);

  const joined = (g) =>
    `@collection.group_members:me.group ?= ${g} && @collection.group_members:me.user ?= @request.auth.id && @collection.group_members:me.invited ?= false`;
  app.save(new Collection({
    type: "base",
    name: "group_messages",
    fields: [
      group,
      player("from", false), // none: the server's line
      { name: "type", type: "select", required: true, maxSelect: 1, values: ["text", "voice", "deleted", "system"] },
      { name: "text", type: "text", max: 500 },
      { name: "data", type: "json", maxSize: 500 }, // a system line: what happened
      { name: "replyTo", type: "text", max: 36, pattern: "^[A-Za-z0-9]*$" },
      { name: "seconds", type: "number", onlyInt: true, min: 0, max: 60 },
      { name: "wave", type: "text", max: 64, pattern: "^[0-9]*$" },
      { name: "voice", type: "file", maxSelect: 1, maxSize: 614400, protected: true },
      { name: "reactions", type: "json", maxSize: 4000 }, // each member's emoji
      { name: "saved", type: "bool" },
      created,
    ],
    indexes: ["CREATE INDEX idx_group_messages_group ON group_messages (`group`, created)"],
    listRule: joined("group"),
    viewRule: joined("group"),
    createRule: [
      joined("@request.body.group"),
      "@request.body.from = @request.auth.id",
      '(@request.body.type = "text" || @request.body.type = "voice")',
      '(@request.body.type != "voice" || (@request.body.seconds >= 1 && @request.body.voice:isset = true))',
      '(@request.body.type = "voice" || @request.body.voice:isset = false)',
      '@request.body.text != ""',
      ...["data", "reactions", "saved"].map((f) => `@request.body.${f}:isset = false`),
    ].join(" && "),
    // Deleting my own for everyone: a mark stays, its text and sound gone.
    updateRule: [
      "from = @request.auth.id",
      'type != "deleted"',
      'type != "system"',
      '@request.body.type = "deleted"',
      '@request.body.text = "-"',
      ...["group", "from", "data", "reactions", "saved", "replyTo"].map((f) => `@request.body.${f}:isset = false`),
    ].join(" && "),
  }));

  app.save(new Collection({
    type: "view",
    name: "group_chats",
    listRule: "user = @request.auth.id",
    viewRule: "user = @request.auth.id",
    viewQuery: VIEW,
  }));

  const clanMembers = app.findCollectionByNameOrId("clan_members");
  clanMembers.fields.add(new DateField({ name: "readAt" }));
  clanMembers.fields.add(new BoolField({ name: "muted" }));
  clanMembers.updateRule = [
    "user = @request.auth.id",
    ...["clan", "user", "role"].map((f) => `@request.body.${f}:isset = false`),
  ].join(" && ");
  app.save(clanMembers);
}, (app) => {
  const clanMembers = app.findCollectionByNameOrId("clan_members");
  clanMembers.updateRule = null;
  clanMembers.fields.removeByName("readAt");
  clanMembers.fields.removeByName("muted");
  app.save(clanMembers);
  for (const name of ["group_chats", "group_messages", "group_members", "groups"]) {
    app.delete(app.findCollectionByNameOrId(name));
  }
});
