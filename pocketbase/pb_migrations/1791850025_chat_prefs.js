/**
 * The Chat tab (2026-11-13). chat_prefs: each player's own settings for a conversation with a friend — pinned at the
 * top (the app keeps three at most), muted (no notification for it). Only he reads or writes them: his friend never
 * learns he was muted. The conversations view gives them with each row, and leaves game-room invitations out of the
 * last message and the unread count (the app shows them in its requests box instead).
 */
const VIEW = (invites) => `
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

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name) => ({
    name, type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const mine = "user = @request.auth.id";
  app.save(new Collection({
    type: "base",
    name: "chat_prefs",
    fields: [player("user"), player("friend"), { name: "pinned", type: "bool" }, { name: "muted", type: "bool" }],
    indexes: ["CREATE UNIQUE INDEX idx_chat_prefs_pair ON chat_prefs (user, friend)"],
    listRule: mine,
    viewRule: mine,
    createRule: "@request.body.user = @request.auth.id && @request.body.friend != @request.auth.id",
    updateRule: `${mine} && @request.body.user:isset = false && @request.body.friend:isset = false`,
    deleteRule: mine,
  }));
  const view = app.findCollectionByNameOrId("conversations");
  view.viewQuery = VIEW(false);
  app.save(view);
}, (app) => {
  const view = app.findCollectionByNameOrId("conversations");
  view.viewQuery = VIEW(true);
  app.save(view);
  app.delete(app.findCollectionByNameOrId("chat_prefs"));
});
