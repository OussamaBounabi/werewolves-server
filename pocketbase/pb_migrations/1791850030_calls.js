/**
 * The Chat tab, phase 6 (2026-11-13): one-to-one calls.
 *
 * calls: one per call, written by the game server only (src/calls.ts); its two players read it and follow it live
 * (ringing → active → ended). outcome: answered, declined (by the one called), cancelled (by the caller), missed (not
 * answered in 45 s), busy (already in a call). messages type "call": the line it leaves in their chat (from the
 * caller; text "📞 12 min", "📹 3 min", or the icon alone when nobody answered).
 */
const NOT_A_CALL = ' && @request.body.type != "call"';
const TYPES = ["text", "invite", "voice", "deleted", "vanish_on", "vanish_off", "flame", "screenshot", "story"];

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name) => ({ name, type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true });
  const both = "caller = @request.auth.id || callee = @request.auth.id";
  app.save(new Collection({
    type: "base",
    name: "calls",
    fields: [
      player("caller"),
      player("callee"),
      { name: "video", type: "bool" },
      { name: "state", type: "select", required: true, maxSelect: 1, values: ["ringing", "active", "ended"] },
      { name: "outcome", type: "select", maxSelect: 1, values: ["answered", "declined", "cancelled", "missed", "busy"] },
      { name: "started", type: "date" },
      { name: "ended", type: "date" },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: ["CREATE INDEX idx_calls_state ON calls (state, created)"],
    listRule: both,
    viewRule: both,
  }));
  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.getByName("type").values = [...TYPES, "call"];
  messages.createRule += NOT_A_CALL; // (the game server's)
  app.save(messages);
}, (app) => {
  const messages = app.findCollectionByNameOrId("messages");
  messages.createRule = messages.createRule.replace(NOT_A_CALL, "");
  messages.fields.getByName("type").values = TYPES;
  app.save(messages);
  app.delete(app.findCollectionByNameOrId("calls"));
});
