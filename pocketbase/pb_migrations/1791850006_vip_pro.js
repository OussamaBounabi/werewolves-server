/**
 * VIP Pro: a level above VIP. A VIP Pro player picks his own role in a werewolf room, host or not. Like `vip`, only
 * the game server sets it (scripts/set-vip.ts): the users' updateRule stays null.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new BoolField({ name: "vipPro" }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("vipPro");
  app.save(users);
});
