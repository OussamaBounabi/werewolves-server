/**
 * Friends and chat, written by the apps themselves under these rules (no game logic here):
 * - friend_requests, then friends: a friendship is two rows (one per side), created by the player who
 *   accepts, in the same batch request that deletes the request.
 * - messages: only to a friend, and never while both players are in the same game room (anti-cheat;
 *   the game server keeps users.room up to date).
 * - chat_reads: "I read my chat with him up to now". Readable by the friend too ("seen").
 * - conversations: a read-only view, one row per friend: the last message and how many are unread.
 *
 * Dates: `created` / chat_reads.`at` are PocketBase's (server time). Rows copied from Firebase also keep
 * their original date in `firebaseAt`; the copy inserts them in their original order, so sorting and
 * unread counts by server time give the same answers as before.
 */

const NOT_IMPORTED = "@request.body.firebaseAt:isset = false"; // only the migration sets it

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name) => ({
    name, type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const created = { name: "created", type: "autodate", onCreate: true };

  const requests = new Collection({
    type: "base",
    name: "friend_requests",
    fields: [player("from"), player("to"), { name: "firebaseAt", type: "date" }, created],
    indexes: [
      "CREATE UNIQUE INDEX idx_friend_requests_pair ON friend_requests (`from`, `to`)",
      "CREATE INDEX idx_friend_requests_to ON friend_requests (`to`)",
    ],
  });
  app.save(requests);

  const friends = new Collection({
    type: "base",
    name: "friends",
    fields: [player("user"), player("friend"), { name: "firebaseAt", type: "date" }, created],
    indexes: [
      "CREATE UNIQUE INDEX idx_friends_pair ON friends (user, friend)",
      "CREATE INDEX idx_friends_friend ON friends (friend)",
    ],
  });
  app.save(friends);

  // (Each needs the other to exist first.)
  requests.listRule = "from = @request.auth.id || to = @request.auth.id";
  requests.viewRule = requests.listRule;
  requests.createRule = [
    "@request.body.from = @request.auth.id",
    "@request.body.to != @request.auth.id",
    "@request.auth.friends_via_user.friend != @request.body.to", // not already friends
    NOT_IMPORTED,
  ].join(" && ");
  requests.deleteRule = "from = @request.auth.id || to = @request.auth.id"; // cancel, decline, accept
  app.save(requests);

  friends.listRule = "user = @request.auth.id || friend = @request.auth.id";
  friends.viewRule = friends.listRule;
  // Only the player who received the request creates the two rows: his own and the requester's.
  friends.createRule = NOT_IMPORTED + " && (" + [
    "(@request.body.user = @request.auth.id && @collection.friend_requests:mine.from ?= @request.body.friend && @collection.friend_requests:mine.to ?= @request.auth.id)",
    "(@request.body.friend = @request.auth.id && @collection.friend_requests:theirs.from ?= @request.body.user && @collection.friend_requests:theirs.to ?= @request.auth.id)",
  ].join(" || ") + ")";
  friends.deleteRule = "user = @request.auth.id || friend = @request.auth.id"; // either side unfriends (both rows)
  app.save(friends);

  app.save(new Collection({
    type: "base",
    name: "chat_reads",
    fields: [player("user"), player("friend"), { name: "at", type: "autodate", onCreate: true, onUpdate: true }],
    indexes: ["CREATE UNIQUE INDEX idx_chat_reads_pair ON chat_reads (user, friend)"],
    listRule: "user = @request.auth.id || friend = @request.auth.id",
    viewRule: "user = @request.auth.id || friend = @request.auth.id",
    createRule: "@request.body.user = @request.auth.id && @request.auth.friends_via_user.friend ?= @request.body.friend",
    // Any update, even an empty one, moves `at` to now: that's how the app marks the chat read.
    updateRule: "user = @request.auth.id && @request.body.user:isset = false && @request.body.friend:isset = false",
    deleteRule: "user = @request.auth.id",
  }));

  app.save(new Collection({
    type: "base",
    name: "messages",
    fields: [
      // Messages copied from Firebase keep their Firestore id (20 characters).
      { name: "id", type: "text", primaryKey: true, required: true, system: true, min: 1, max: 36, pattern: "^[A-Za-z0-9]+$", autogeneratePattern: "[a-z0-9]{15}" },
      player("from"),
      player("to"),
      { name: "type", type: "select", maxSelect: 1, values: ["text", "invite", "voice"] }, // empty = text
      { name: "text", type: "text", required: true, min: 1, max: 500 }, // a voice message's fallback line too
      { name: "roomId", type: "text", max: 64 }, // invite
      { name: "roomHost", type: "text", max: 64 }, // invite
      { name: "seconds", type: "number", onlyInt: true, min: 0, max: 60 }, // voice
      { name: "wave", type: "text", max: 64, pattern: "^[0-9]*$" }, // voice: up to 64 digits
      // voice: AAC in .m4a, up to 600 KB; protected = only the two players can download it (with a file token)
      { name: "voice", type: "file", maxSelect: 1, maxSize: 614400, protected: true },
      { name: "firebaseAt", type: "date" },
      created,
    ],
    indexes: [
      "CREATE INDEX idx_messages_pair ON messages (`from`, `to`, created)",
      "CREATE INDEX idx_messages_to ON messages (`to`, created)",
    ],
    listRule: "from = @request.auth.id || to = @request.auth.id",
    viewRule: "from = @request.auth.id || to = @request.auth.id",
    createRule: [
      "@request.body.from = @request.auth.id",
      "@request.auth.friends_via_user.friend ?= @request.body.to", // friends only
      '(@request.auth.room = "" || @request.body.to.room != @request.auth.room)', // not in the same game
      '(@request.body.type != "voice" || (@request.body.seconds >= 1 && @request.body.voice:isset = true))',
      '(@request.body.type = "voice" || @request.body.voice:isset = false)',
      '(@request.body.type != "invite" || @request.body.roomId != "")',
      NOT_IMPORTED,
    ].join(" && "),
  }));

  // One row per friendship: the conversation list and its unread badges in one request.
  app.save(new Collection({
    type: "view",
    name: "conversations",
    listRule: "user = @request.auth.id",
    viewRule: "user = @request.auth.id",
    viewQuery: `
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
          WHERE u.\`from\` = f.friend AND u.\`to\` = f.user
            AND u.created > COALESCE((SELECT r.at FROM chat_reads r WHERE r.user = f.user AND r.friend = f.friend), '')
        )) AS INTEGER) AS unread,
        CAST(COALESCE(m.\`from\` = f.user AND m.created <= (
          SELECT r.at FROM chat_reads r WHERE r.user = f.friend AND r.friend = f.user
        ), 0) AS BOOLEAN) AS seen
      FROM friends f
      LEFT JOIN messages m ON m.id = (
        SELECT x.id FROM messages x
        WHERE (x.\`from\` = f.user AND x.\`to\` = f.friend) OR (x.\`from\` = f.friend AND x.\`to\` = f.user)
        ORDER BY x.created DESC, x.firebaseAt DESC
        LIMIT 1
      )`,
  }));
}, (app) => {
  for (const name of ["conversations", "messages", "chat_reads", "friends", "friend_requests"]) {
    app.delete(app.findCollectionByNameOrId(name));
  }
});
