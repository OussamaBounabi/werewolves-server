/**
 * The Chat tab, phase 4 (2026-11-13): flames and streaks.
 *
 * flame_media: a photo or a video (15 s at most) its sender uploads, with what he drew, wrote and stuck on it (overlay:
 * drawn over it when it's shown). The game server sends it (src/flames.ts): a messages row (type flame) to each friend
 * and a group_messages row to each group; views: how many times it was seen (1: opened, 2: replayed: then it's gone); a
 * group's views per member. The game server deletes the media once everyone saw it twice, 24 h after it was sent if
 * nobody opened it, and 48 h after it was sent at most. A screenshot tried shows as a line (type screenshot).
 * streaks: two friends' flame streak (user1 the smaller id): days in a row (Algiers' day) both sent each other one;
 * day1 / day2: the last day each did; lastDay: the last day both did. Written by the game server only.
 * flame_reports: a copy of a reported flame, for support, kept 7 days. users.streakFree: the month a VIP used his free
 * streak restore.
 */
const FRIEND_ONLY = "@request.auth.friends_via_user.friend ?= @request.body.to";

const FIELDS = ["from", "to", "type", "text", "roomId", "roomHost", "seconds", "wave", "voice", "firebaseAt", "replyTo"];
const EVERY = [...FIELDS, "fromReaction", "toReaction", "saved", "seenAt", "flame", "views"];
const EVERY_BEFORE = [...FIELDS, "fromReaction", "toReaction", "saved", "seenAt"];
const unset = (every, but) => every.filter((f) => f !== but).map((f) => `@request.body.${f}:isset = false`).join(" && ");
const DELETING = [
  "from = @request.auth.id",
  'type != "deleted"',
  '@request.body.type = "deleted"',
  '@request.body.text = "-"',
  "@request.body.from:isset = false",
  "@request.body.to:isset = false",
  "@request.body.firebaseAt:isset = false",
].join(" && ");
const update = (every) => [
  `(${DELETING} && ${["saved", "seenAt", ...(every === EVERY ? ["flame", "views"] : [])].map((f) => `@request.body.${f}:isset = false`).join(" && ")})`,
  `(from = @request.auth.id && type != "deleted" && @request.body.fromReaction:isset = true && ${unset(every, "fromReaction")})`,
  `(to = @request.auth.id && type != "deleted" && @request.body.toReaction:isset = true && ${unset(every, "toReaction")})`,
  `((from = @request.auth.id || to = @request.auth.id) && type != "deleted" && @request.body.saved:isset = true && ${unset(every, "saved")})`,
].join(" || ");

const NO_FLAME = ' && @request.body.type != "flame" && @request.body.flame:isset = false && @request.body.views:isset = false';
const TYPES = ["text", "invite", "voice", "deleted", "vanish_on", "vanish_off"];
const GROUP_TYPES = ["text", "voice", "deleted", "system"];
const GROUP_WRITES = '(@request.body.type = "text" || @request.body.type = "voice")';
const GROUP_WRITES_NOW = '(@request.body.type = "text" || @request.body.type = "voice" || @request.body.type = "screenshot")';

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name, required = true) => ({
    name, type: "relation", required, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const created = { name: "created", type: "autodate", onCreate: true };

  const media = new Collection({
    type: "base",
    name: "flame_media",
    fields: [
      player("from"),
      {
        name: "media", type: "file", required: true, maxSelect: 1, maxSize: 12 * 1024 * 1024, protected: true,
        mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "video/mp4", "video/quicktime", "video/3gpp", "video/webm"],
      },
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["photo", "video"] },
      { name: "seconds", type: "number", onlyInt: true, min: 0, max: 15 },
      { name: "overlay", type: "json", maxSize: 20000 }, // caption, drawing, stickers
      created,
    ],
    createRule: "@request.body.from = @request.auth.id",
  });
  app.save(media);
  const flame = { name: "flame", type: "relation", collectionId: media.id, maxSelect: 1, cascadeDelete: false };

  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.getByName("type").values = [...TYPES, "flame", "screenshot"];
  messages.fields.add(new RelationField(flame));
  messages.fields.add(new NumberField({ name: "views", onlyInt: true, min: 0, max: 2 }));
  messages.createRule += NO_FLAME;
  messages.updateRule = update(EVERY);
  app.save(messages);

  const lines = app.findCollectionByNameOrId("group_messages");
  lines.fields.getByName("type").values = [...GROUP_TYPES, "flame", "screenshot"];
  lines.fields.add(new RelationField(flame));
  lines.fields.add(new JSONField({ name: "views", maxSize: 4000 })); // each member's (1 or 2)
  lines.createRule = lines.createRule.replace(GROUP_WRITES, GROUP_WRITES_NOW) +
    " && @request.body.flame:isset = false && @request.body.views:isset = false";
  app.save(lines);

  // Its sender, and whoever got it (a friend, or a member of a group it went to).
  media.listRule = "from = @request.auth.id || messages_via_flame.to ?= @request.auth.id || " +
    "group_messages_via_flame.group.group_members_via_group.user ?= @request.auth.id";
  media.viewRule = media.listRule;
  app.save(media);

  app.save(new Collection({
    type: "base",
    name: "streaks",
    fields: [
      player("user1"),
      player("user2"),
      { name: "count", type: "number", onlyInt: true, min: 0 },
      { name: "day1", type: "text", max: 10 },
      { name: "day2", type: "text", max: 10 },
      { name: "lastDay", type: "text", max: 10 },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_streaks_pair ON streaks (user1, user2)"],
    listRule: "user1 = @request.auth.id || user2 = @request.auth.id",
    viewRule: "user1 = @request.auth.id || user2 = @request.auth.id",
  }));

  app.save(new Collection({
    type: "base",
    name: "flame_reports",
    fields: [
      player("reporter"),
      player("from"),
      { name: "media", type: "file", maxSelect: 1, maxSize: 12 * 1024 * 1024, protected: true },
      { name: "kind", type: "text", max: 10 },
      { name: "overlay", type: "json", maxSize: 20000 },
      created,
    ],
  }));

  users.fields.add(new TextField({ name: "streakFree", max: 7 }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("streakFree");
  app.save(users);
  for (const name of ["flame_reports", "streaks"]) app.delete(app.findCollectionByNameOrId(name));
  const lines = app.findCollectionByNameOrId("group_messages");
  lines.createRule = lines.createRule
    .replace(" && @request.body.flame:isset = false && @request.body.views:isset = false", "")
    .replace(GROUP_WRITES_NOW, GROUP_WRITES);
  lines.fields.removeByName("flame");
  lines.fields.removeByName("views");
  lines.fields.getByName("type").values = GROUP_TYPES;
  app.save(lines);
  const messages = app.findCollectionByNameOrId("messages");
  messages.createRule = messages.createRule.replace(NO_FLAME, "");
  messages.updateRule = update(EVERY_BEFORE);
  messages.fields.removeByName("flame");
  messages.fields.removeByName("views");
  messages.fields.getByName("type").values = TYPES;
  app.save(messages);
  app.delete(app.findCollectionByNameOrId("flame_media"));
});
