/**
 * Deleting a message for everyone: its writer turns it into a "deleted" mark, so the other player still sees
 * that a message was there. Only that one change is allowed: the type, with the text wiped to "-" (the app
 * empties the sound and the invite with it). A mark can't be changed again, and nothing deletes the row.
 */
migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.getByName("type").values = ["text", "invite", "voice", "deleted"];
  messages.updateRule = [
    "from = @request.auth.id",
    'type != "deleted"',
    '@request.body.type = "deleted"',
    '@request.body.text = "-"',
    "@request.body.from:isset = false",
    "@request.body.to:isset = false",
    "@request.body.firebaseAt:isset = false",
  ].join(" && ");
  app.save(messages);
  app.save(app.findCollectionByNameOrId("conversations")); // its lastType follows the new list of types
}, (app) => {
  const messages = app.findCollectionByNameOrId("messages");
  messages.updateRule = null;
  messages.fields.getByName("type").values = ["text", "invite", "voice"];
  app.save(messages);
  app.save(app.findCollectionByNameOrId("conversations"));
});
