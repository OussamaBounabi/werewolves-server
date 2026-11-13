/**
 * The Chat tab, phase 2 (2026-11-13).
 *
 * message_requests: a VIP Pro writing to a player who isn't his friend. He makes the request (with his first line), then
 * writes; the other accepts (they may then chat, without being friends) or deletes it (nothing more can be sent). Blocking
 * either way stops it, as it stops friend requests.
 *
 * chat_modes: one row per pair once someone changed it: keep = the chats stay (until the 30-day cleanup); none or
 * keep = false: chats vanish 24 h after they're seen (the game server deletes them, saved ones aside). A message of
 * type vanish_on / vanish_off is the line in the chat that says who changed it (its text: what older apps show).
 *
 * messages: saved (either player holds a message to keep it), seenAt (when the game server found it seen), the
 * vanish lines' types; written to a friend or along a message request. conversations: the request chats too (the
 * sender's as soon as he wrote, the other's once accepted), with `request` ('', sent, accepted) and `keep`; invitations
 * and vanish lines left out of the last message and the unread count.
 */
const FRIEND_ONLY = "@request.auth.friends_via_user.friend ?= @request.body.to";
const NOT_BLOCKED = (other) =>
  `@request.auth.blocks_via_user.blocked != ${other} && ${other}.blocks_via_user.blocked != @request.auth.id`;
// I may write to [other] along a request: mine to him, pending (I'm VIP Pro) or accepted; or his to me, accepted.
const BY_REQUEST = (other) => `(${NOT_BLOCKED(other)} && (` +
  `(@collection.message_requests:mine.from ?= @request.auth.id && @collection.message_requests:mine.to ?= ${other} && ` +
  `(@collection.message_requests:mine.state ?= "accepted" || (@collection.message_requests:mine.state ?= "" && @request.auth.vipPro = true))) || ` +
  `(@collection.message_requests:theirs.from ?= ${other} && @collection.message_requests:theirs.to ?= @request.auth.id && ` +
  `@collection.message_requests:theirs.state ?= "accepted")))`;
const TO_ANYONE = `(${FRIEND_ONLY} || ${BY_REQUEST("@request.body.to")})`;
const READ_FRIEND = "@request.auth.friends_via_user.friend ?= @request.body.friend";
const READ_ANYONE = `(${READ_FRIEND} || ${BY_REQUEST("@request.body.friend")})`;

const TYPES = ["text", "invite", "voice", "deleted"];
const FIELDS = ["from", "to", "type", "text", "roomId", "roomHost", "seconds", "wave", "voice", "firebaseAt", "replyTo"];
const EVERY = [...FIELDS, "fromReaction", "toReaction", "saved", "seenAt"];
const unset = (but) => EVERY.filter((f) => f !== but).map((f) => `@request.body.${f}:isset = false`).join(" && ");
const unsetOld = (but) => [...FIELDS, but === "fromReaction" ? "toReaction" : "fromReaction"].map((f) => `@request.body.${f}:isset = false`).join(" && ");
const DELETING = [
  "from = @request.auth.id",
  'type != "deleted"',
  '@request.body.type = "deleted"',
  '@request.body.text = "-"',
  "@request.body.from:isset = false",
  "@request.body.to:isset = false",
  "@request.body.firebaseAt:isset = false",
].join(" && ");
const UPDATE = [
  `(${DELETING} && @request.body.saved:isset = false && @request.body.seenAt:isset = false)`,
  `(from = @request.auth.id && type != "deleted" && @request.body.fromReaction:isset = true && ${unset("fromReaction")})`,
  `(to = @request.auth.id && type != "deleted" && @request.body.toReaction:isset = true && ${unset("toReaction")})`,
  `((from = @request.auth.id || to = @request.auth.id) && type != "deleted" && @request.body.saved:isset = true && ${unset("saved")})`,
].join(" || ");
const OLD_UPDATE = [
  `(${DELETING})`,
  `(from = @request.auth.id && type != "deleted" && @request.body.fromReaction:isset = true && ${unsetOld("fromReaction")})`,
  `(to = @request.auth.id && type != "deleted" && @request.body.toReaction:isset = true && ${unsetOld("toReaction")})`,
].join(" || ");

const HIDDEN = "('invite', 'vanish_on', 'vanish_off')"; // not a conversation's last line, not unread
const VIEW = `
      SELECT
        CAST(f.id AS TEXT) AS id,
        CAST(f.user AS TEXT) AS user,
        CAST(f.friend AS TEXT) AS friend,
        CAST(f.request AS TEXT) AS request,
        m.text AS lastMessage,
        m.\`from\` AS lastFrom,
        m.type AS lastType,
        CAST(COALESCE(NULLIF(m.firebaseAt, ''), m.created, '') AS TEXT) AS updatedAt,
        CAST(MIN(99, (
          SELECT COUNT(*) FROM messages u
          WHERE u.\`from\` = f.friend AND u.\`to\` = f.user AND COALESCE(u.type, '') NOT IN ${HIDDEN}
            AND u.created > COALESCE((SELECT r.at FROM chat_reads r WHERE r.user = f.user AND r.friend = f.friend), '')
        )) AS INTEGER) AS unread,
        CAST(COALESCE(m.\`from\` = f.user AND m.created <= (
          SELECT r.at FROM chat_reads r WHERE r.user = f.friend AND r.friend = f.user
        ), 0) AS BOOLEAN) AS seen,
        CAST(COALESCE(p.pinned, 0) AS BOOLEAN) AS pinned,
        CAST(COALESCE(p.muted, 0) AS BOOLEAN) AS muted,
        CAST(COALESCE((SELECT c.keep FROM chat_modes c
          WHERE (c.user1 = f.user AND c.user2 = f.friend) OR (c.user1 = f.friend AND c.user2 = f.user)), 0) AS BOOLEAN) AS keep
      FROM (
        SELECT id, user, friend, '' AS request FROM friends
        UNION ALL
        SELECT q.id, q.\`from\`, q.\`to\`, CASE WHEN q.state = 'accepted' THEN 'accepted' ELSE 'sent' END
        FROM message_requests q
        WHERE NOT EXISTS (SELECT 1 FROM friends x WHERE x.user = q.\`from\` AND x.friend = q.\`to\`)
        UNION ALL
        SELECT 'q' || SUBSTR(q.id, 2), q.\`to\`, q.\`from\`, 'accepted'
        FROM message_requests q
        WHERE q.state = 'accepted' AND NOT EXISTS (SELECT 1 FROM friends x WHERE x.user = q.\`from\` AND x.friend = q.\`to\`)
      ) f
      LEFT JOIN messages m ON m.id = (
        SELECT x.id FROM messages x
        WHERE ((x.\`from\` = f.user AND x.\`to\` = f.friend) OR (x.\`from\` = f.friend AND x.\`to\` = f.user))
          AND COALESCE(x.type, '') NOT IN ${HIDDEN}
        ORDER BY x.created DESC, x.firebaseAt DESC
        LIMIT 1
      )
      LEFT JOIN chat_prefs p ON p.user = f.user AND p.friend = f.friend`;

const VIEW_BEFORE_OF = (invites) => `
      SELECT
        f.id AS id,
        f.user AS user,
        f.friend AS friend,
        m.text AS lastMessage,
        m.\`from\` AS lastFrom,
        m.type AS lastType,
        CAST(COALESCE(NULLIF(m.firebaseAt, ''), m.created, '') AS TEXT) AS updatedAt,
        CAST(MIN(99, (
          SELECT COUNT(*) FROM messages u
          WHERE u.\`from\` = f.friend AND u.\`to\` = f.user${invites ? "" : " AND COALESCE(u.type, '') != 'invite'"}
            AND u.created > COALESCE((SELECT r.at FROM chat_reads r WHERE r.user = f.user AND r.friend = f.friend), '')
        )) AS INTEGER) AS unread,
        CAST(COALESCE(m.\`from\` = f.user AND m.created <= (
          SELECT r.at FROM chat_reads r WHERE r.user = f.friend AND r.friend = f.user
        ), 0) AS BOOLEAN) AS seen${invites ? "" : `,
        CAST(COALESCE(p.pinned, 0) AS BOOLEAN) AS pinned,
        CAST(COALESCE(p.muted, 0) AS BOOLEAN) AS muted`}
      FROM friends f
      LEFT JOIN messages m ON m.id = (
        SELECT x.id FROM messages x
        WHERE ((x.\`from\` = f.user AND x.\`to\` = f.friend) OR (x.\`from\` = f.friend AND x.\`to\` = f.user))${invites ? "" : `
          AND COALESCE(x.type, '') != 'invite'`}
        ORDER BY x.created DESC, x.firebaseAt DESC
        LIMIT 1
      )${invites ? "" : `
      LEFT JOIN chat_prefs p ON p.user = f.user AND p.friend = f.friend`}`;

// (1791850025's query, for going back.)
const VIEW_BEFORE = VIEW_BEFORE_OF(false);

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name) => ({
    name, type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const either = "from = @request.auth.id || to = @request.auth.id";
  app.save(new Collection({
    type: "base",
    name: "message_requests",
    fields: [
      player("from"),
      player("to"),
      { name: "state", type: "select", maxSelect: 1, values: ["accepted", "deleted"] }, // empty: waiting
      { name: "text", type: "text", max: 300 }, // his first line, for the requests box
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_message_requests_pair ON message_requests (`from`, `to`)",
      "CREATE INDEX idx_message_requests_to ON message_requests (`to`)",
    ],
    listRule: either,
    viewRule: either,
    createRule: [
      "@request.body.from = @request.auth.id",
      "@request.auth.vipPro = true",
      "@request.body.to != @request.auth.id",
      "@request.body.state:isset = false",
      "@request.auth.friends_via_user.friend != @request.body.to",
      NOT_BLOCKED("@request.body.to"),
    ].join(" && "),
    // Only who got it answers it, once: accepted or deleted.
    updateRule: 'to = @request.auth.id && state = "" && (@request.body.state = "accepted" || @request.body.state = "deleted") && ' +
      "@request.body.from:isset = false && @request.body.to:isset = false && @request.body.text:isset = false",
  }));

  app.save(new Collection({
    type: "base",
    name: "chat_modes",
    fields: [player("user1"), player("user2"), { name: "keep", type: "bool" }],
    indexes: ["CREATE UNIQUE INDEX idx_chat_modes_pair ON chat_modes (user1, user2)"],
    listRule: "user1 = @request.auth.id || user2 = @request.auth.id",
    viewRule: "user1 = @request.auth.id || user2 = @request.auth.id",
    // One row a pair: the smaller id first.
    createRule: "(@request.body.user1 = @request.auth.id || @request.body.user2 = @request.auth.id) && @request.body.user1 < @request.body.user2",
    updateRule: "(user1 = @request.auth.id || user2 = @request.auth.id) && @request.body.user1:isset = false && @request.body.user2:isset = false",
  }));

  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.getByName("type").values = [...TYPES, "vanish_on", "vanish_off"];
  messages.fields.add(new BoolField({ name: "saved" }));
  messages.fields.add(new DateField({ name: "seenAt" }));
  messages.createRule = messages.createRule.replace(FRIEND_ONLY, TO_ANYONE) +
    " && @request.body.saved:isset = false && @request.body.seenAt:isset = false";
  messages.updateRule = UPDATE;
  messages.addIndex("idx_messages_seen", false, "seenAt", "");
  app.save(messages);

  const reads = app.findCollectionByNameOrId("chat_reads");
  reads.createRule = reads.createRule.replace(READ_FRIEND, READ_ANYONE);
  app.save(reads);

  const view = app.findCollectionByNameOrId("conversations");
  view.viewQuery = VIEW;
  app.save(view);
}, (app) => {
  const view = app.findCollectionByNameOrId("conversations");
  view.viewQuery = VIEW_BEFORE;
  app.save(view);
  const reads = app.findCollectionByNameOrId("chat_reads");
  reads.createRule = reads.createRule.replace(READ_ANYONE, READ_FRIEND);
  app.save(reads);
  const messages = app.findCollectionByNameOrId("messages");
  messages.createRule = messages.createRule
    .replace(" && @request.body.saved:isset = false && @request.body.seenAt:isset = false", "")
    .replace(TO_ANYONE, FRIEND_ONLY);
  messages.updateRule = OLD_UPDATE;
  messages.removeIndex("idx_messages_seen");
  messages.fields.removeByName("saved");
  messages.fields.removeByName("seenAt");
  messages.fields.getByName("type").values = TYPES;
  app.save(messages);
  app.delete(app.findCollectionByNameOrId("chat_modes"));
  app.delete(app.findCollectionByNameOrId("message_requests"));
});
