/**
 * Player accounts: PocketBase's own `users` auth collection, reshaped to hold the profile Firestore kept in
 * users/{uid}. Accounts copied from Firebase keep their Firebase uid as id (28 letters and digits); new ones
 * get PocketBase's usual 15-character id.
 *
 * Players sign up here directly (e-mail + password, or Google). Everything else on the profile is written
 * by the game server, signed in as a superuser: the rules below only let a player set his starting
 * username, name and free avatar, and later change his own password. Name, avatar, frame and a Google
 * player's first username go through the game server's POST /api/profile (it checks the 24 h rule and
 * what he owns).
 */

/** Written by the game server only (or chosen through it): a player may never set them himself. */
const SERVER_FIELDS = [
  "nameChangedAt", "frame", "avatars", "frames", "xp", "coins", "diamonds", "rankPoints", "stats",
  "room", "vip", "welcomeGift", "createdAt", "legacyAuth",
];
/** Set once at sign-up, then only through the game server. */
const PROFILE_FIELDS = ["username", "name", "avatar"];
/** The two avatars everyone has (FREE_AVATARS in src/avatars.ts): a new account starts with one of them. */
const FREE_AVATARS = [103, 104];

const absent = (fields) => fields.map((f) => `@request.body.${f}:isset = false`).join(" && ");

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  // Firebase uids are kept as ids (mixed case, 28 characters).
  const id = users.fields.getByName("id");
  id.pattern = "^[A-Za-z0-9]+$";
  id.min = 1;
  id.max = 36;
  // Firebase accepted 6-character passwords: those players' passwords move here as they are.
  users.fields.getByName("password").min = 6;
  // Display names: 3 to 16 letters, digits or _ (a Google player has none until he sets up his profile).
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
    new BoolField({ name: "legacyAuth", hidden: true }),
  );
  // Unique usernames; a Google player has none until he picks it.
  users.addIndex("idx_users_username", true, "username", "username != ''");
  users.addIndex("idx_users_welcome", false, "welcomeGift", "");

  users.listRule = '@request.auth.id != ""';
  users.viewRule = '@request.auth.id != ""';
  users.createRule = [
    "@request.body.id:isset = false",
    "@request.body.verified:isset = false",
    absent(SERVER_FIELDS),
    `(@request.body.avatar:isset = false || ${FREE_AVATARS.map((a) => `@request.body.avatar = ${a}`).join(" || ")})`,
  ].join(" && ");
  // His own password (with oldPassword) and emailVisibility: nothing else.
  users.updateRule = [
    "id = @request.auth.id",
    "@request.body.email:isset = false",
    "@request.body.verified:isset = false",
    absent(PROFILE_FIELDS),
    absent(SERVER_FIELDS),
  ].join(" && ");
  users.deleteRule = "id = @request.auth.id"; // deleting his account takes everything of his with it

  // Google's name and picture don't fit our name (3 to 16 letters, digits or _) and avatar (a number).
  users.oauth2.mappedFields.name = "";
  users.oauth2.mappedFields.avatarURL = "";
  // New-device e-mails need SMTP; turn them back on once it's set up, if wanted.
  users.authAlert.enabled = false;

  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  for (const f of [...SERVER_FIELDS, "username", "avatar"]) users.fields.removeByName(f);
  users.fields.add(new FileField({ name: "avatar", maxSelect: 1, mimeTypes: ["image/jpeg", "image/png", "image/svg+xml", "image/gif", "image/webp"] }));
  users.removeIndex("idx_users_username");
  users.removeIndex("idx_users_welcome");
  users.listRule = "id = @request.auth.id";
  users.viewRule = "id = @request.auth.id";
  users.createRule = "";
  users.updateRule = "id = @request.auth.id";
  users.deleteRule = "id = @request.auth.id";
  users.oauth2.mappedFields.name = "name";
  users.oauth2.mappedFields.avatarURL = "avatar";
  users.authAlert.enabled = true;
  app.save(users);
});
