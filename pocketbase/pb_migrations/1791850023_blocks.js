/**
 * blocks: who a player blocked. Only he reads and writes his own. A player can't ask someone he blocked, or someone who
 * blocked him, to be his friend; the apps' search leaves out those who blocked the one searching.
 */
const NOT_BLOCKED = ' && @request.auth.blocks_via_user.blocked != @request.body.to && @request.body.to.blocks_via_user.blocked != @request.auth.id';

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const mine = "user = @request.auth.id";
  app.save(new Collection({
    type: "base",
    name: "blocks",
    fields: [
      { name: "user", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "blocked", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_blocks_pair ON blocks (user, blocked)",
      "CREATE INDEX idx_blocks_blocked ON blocks (blocked)",
    ],
    listRule: mine,
    viewRule: mine,
    createRule: "@request.body.user = @request.auth.id && @request.body.blocked != @request.auth.id",
    deleteRule: mine,
  }));
  const requests = app.findCollectionByNameOrId("friend_requests");
  requests.createRule += NOT_BLOCKED;
  app.save(requests);
}, (app) => {
  const requests = app.findCollectionByNameOrId("friend_requests");
  requests.createRule = requests.createRule.replace(NOT_BLOCKED, "");
  app.save(requests);
  app.delete(app.findCollectionByNameOrId("blocks"));
});
