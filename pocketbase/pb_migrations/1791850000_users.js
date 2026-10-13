/**
 * Player accounts: PocketBase's own `users` auth collection, reshaped to hold the profile Firestore kept in
 * users/{uid}. The id is the player's Firebase uid (28 letters and digits).
 *
 * PocketBase is the database only: players sign up and log in with Firebase Auth, as before. Nobody logs
 * in to PocketBase or signs up on it: password and OAuth2 login are off, and only the game server (a
 * superuser) creates and updates accounts. The game server exchanges an app's Firebase ID token for a
 * PocketBase token (POST /api/auth/exchange) that the app uses to read and write what the rules allow.
 * Name, avatar, frame and the first username go through the game server's POST /api/profile.
 */

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  // Firebase uids are the ids (mixed case, 28 characters).
  const id = users.fields.getByName("id");
  id.pattern = "^[A-Za-z0-9]+$";
  id.min = 1;
  id.max = 36;
  // Display names: 3 to 16 letters, digits or _ (empty until the player sets up his profile).
  const name = users.fields.getByName("name");
  name.max = 16;
  name.pattern = "^[A-Za-z0-9_]{3,16}$";
  users.fields.removeByName("avatar"); // PocketBase's picture upload: ours is a number

  users.fields.add(
    new TextField({ name: "username", max: 16, pattern: "^[a-z0-9_]{3,16}$" }),
    new DateField({ name: "nameChangedAt" }),
    new NumberField({ name: "avatar", onlyInt: true, min: 0 }),
    new NumberField({ name: "frame", onlyInt: true, min: 0 }),
    new JSONField({ name: "avatars", maxSize: 20000 }),
    new JSONField({ name: "frames", maxSize: 2000 }),
    new NumberField({ name: "xp", onlyInt: true, min: 0 }),
    new NumberField({ name: "coins", onlyInt: true, min: 0 }),
    new NumberField({ name: "diamonds", onlyInt: true, min: 0 }),
    new NumberField({ name: "rankPoints", onlyInt: true }),
    new JSONField({ name: "stats", maxSize: 50000 }),
    new TextField({ name: "room", max: 64 }),
    new BoolField({ name: "vip" }),
    new BoolField({ name: "welcomeGift" }),
    new DateField({ name: "createdAt" }),
  );
  // Unique usernames; a new player has none until he picks it.
  users.addIndex("idx_users_username", true, "username", "username != ''");
  users.addIndex("idx_users_welcome", false, "welcomeGift", "");

  users.listRule = '@request.auth.id != ""';
  users.viewRule = '@request.auth.id != ""';
  users.createRule = null; // the game server only
  users.updateRule = null; // the game server only
  users.deleteRule = "id = @request.auth.id"; // deleting his account takes everything of his with it

  // No login on PocketBase itself: its tokens come from the game server's exchange.
  users.passwordAuth.enabled = false;
  users.oauth2.enabled = false;
  users.otp.enabled = false;
  users.mfa.enabled = false;

  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  for (const f of [
    "username", "nameChangedAt", "avatar", "frame", "avatars", "frames", "xp", "coins", "diamonds", "rankPoints",
    "stats", "room", "vip", "welcomeGift", "createdAt",
  ]) users.fields.removeByName(f);
  users.fields.add(new FileField({ name: "avatar", maxSelect: 1, mimeTypes: ["image/jpeg", "image/png", "image/svg+xml", "image/gif", "image/webp"] }));
  const name = users.fields.getByName("name");
  name.max = 255;
  name.pattern = "";
  users.removeIndex("idx_users_username");
  users.removeIndex("idx_users_welcome");
  users.listRule = "id = @request.auth.id";
  users.viewRule = "id = @request.auth.id";
  users.createRule = "";
  users.updateRule = "id = @request.auth.id";
  users.deleteRule = "id = @request.auth.id";
  users.passwordAuth.enabled = true;
  app.save(users);
});
