/**
 * users.roomLook: a VIP Pro's room name and style ({ name, style }), kept on his account so every room he hosts wears
 * them in the rooms lists until he changes them (rooms/perks.ts). Written by the game server only.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "roomLook", maxSize: 300 }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("roomLook");
  app.save(users);
});
