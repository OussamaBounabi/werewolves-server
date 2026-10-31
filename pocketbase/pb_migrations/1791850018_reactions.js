/**
 * A friend chat's reactions and replies. fromReaction / toReaction: each player's emoji on a message (one of six, ""
 * none), each set only by its own player and nothing else with it. replyTo: the message a new one answers (its id).
 * A deleted mark takes no reaction. Deleting stays as it was (the writer's one change, 1791850005).
 */
const EMOJIS = ["❤️", "😆", "😮", "😢", "😠", "👍"];
const FIELDS = ["from", "to", "type", "text", "roomId", "roomHost", "seconds", "wave", "voice", "firebaseAt", "replyTo"];

migrate((app) => {
  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.add(new SelectField({ name: "fromReaction", maxSelect: 1, values: EMOJIS }));
  messages.fields.add(new SelectField({ name: "toReaction", maxSelect: 1, values: EMOJIS }));
  messages.fields.add(new TextField({ name: "replyTo", max: 36, pattern: "^[A-Za-z0-9]*$" }));
  const unset = (others) => [...FIELDS, others].map((f) => `@request.body.${f}:isset = false`).join(" && ");
  const deleting = messages.updateRule;
  messages.updateRule = [
    `(${deleting})`,
    `(from = @request.auth.id && type != "deleted" && @request.body.fromReaction:isset = true && ${unset("toReaction")})`,
    `(to = @request.auth.id && type != "deleted" && @request.body.toReaction:isset = true && ${unset("fromReaction")})`,
  ].join(" || ");
  app.save(messages);
}, (app) => {
  const messages = app.findCollectionByNameOrId("messages");
  messages.updateRule = messages.updateRule.split(" || ")[0].replace(/^\((.*)\)$/, "$1");
  for (const name of ["fromReaction", "toReaction", "replyTo"]) messages.fields.removeByName(name);
  app.save(messages);
});
