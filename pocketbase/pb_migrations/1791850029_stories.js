/**
 * The Chat tab, phase 5 (2026-11-13): stories and notes.
 *
 * stories: a photo or a video (15 s at most) with what was drawn on it (overlay, as a flame's), a sentence on a colour
 * (text, color: the colour's index), or a game moment (data: the game server's, from game_log: src/stories.ts). For
 * 24 hours, to its owner's friends but those in [hidden] (his hide list when it was posted, kept in step by the app);
 * the game server deletes it after. story_views: who watched it, and their reaction; read by its viewer and its owner.
 * story_hides: whom I hide my stories from (mine to read). notes: a line over my avatar in the Chat tab's top row
 * (60 letters), for my friends, 24 hours. messages type "story": a reply to a story, in our chat.
 */
const FRIENDS = "user.friends_via_friend.user ?= @request.auth.id";

const TYPES = ["text", "invite", "voice", "deleted", "vanish_on", "vanish_off", "flame", "screenshot"];

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const player = (name, required = true) => ({
    name, type: "relation", required, collectionId: users.id, maxSelect: 1, cascadeDelete: true,
  });
  const created = { name: "created", type: "autodate", onCreate: true };
  const updated = { name: "updated", type: "autodate", onCreate: true, onUpdate: true };

  const stories = new Collection({
    type: "base",
    name: "stories",
    fields: [
      player("user"),
      { name: "kind", type: "select", required: true, maxSelect: 1, values: ["photo", "video", "text", "game"] },
      {
        name: "media", type: "file", maxSelect: 1, maxSize: 12 * 1024 * 1024, protected: true,
        mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "video/mp4", "video/quicktime", "video/3gpp", "video/webm"],
      },
      { name: "seconds", type: "number", onlyInt: true, min: 0, max: 15 },
      { name: "overlay", type: "json", maxSize: 20000 },
      { name: "text", type: "text", max: 200 },
      { name: "color", type: "number", onlyInt: true, min: 0, max: 20 },
      { name: "data", type: "json", maxSize: 2000 },
      { name: "hidden", type: "relation", collectionId: users.id, maxSelect: 1000, cascadeDelete: false },
      created,
    ],
    indexes: ["CREATE INDEX idx_stories_user ON stories (user, created)"],
    listRule: `user = @request.auth.id || (created > @yesterday && ${FRIENDS} && hidden.id != @request.auth.id)`,
    viewRule: `user = @request.auth.id || (created > @yesterday && ${FRIENDS} && hidden.id != @request.auth.id)`,
    // Mine, not a game's (the game server writes those); a photo or a video comes with its file, a sentence with its text.
    createRule: '@request.body.user = @request.auth.id && @request.body.kind != "game" && @request.body.data:isset = false && ' +
      '(@request.body.kind = "text" || @request.body.media:isset = true) && (@request.body.kind != "text" || @request.body.text != "")',
    updateRule: "user = @request.auth.id && " +
      ["user", "kind", "media", "seconds", "overlay", "text", "color", "data"].map((f) => `@request.body.${f}:isset = false`).join(" && "),
    deleteRule: "user = @request.auth.id",
  });
  app.save(stories);

  app.save(new Collection({
    type: "base",
    name: "story_views",
    fields: [
      { name: "story", type: "relation", required: true, collectionId: stories.id, maxSelect: 1, cascadeDelete: true },
      player("user"),
      { name: "reaction", type: "text", max: 8 },
      created,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_story_views ON story_views (story, user)"],
    listRule: "user = @request.auth.id || story.user = @request.auth.id",
    viewRule: "user = @request.auth.id || story.user = @request.auth.id",
    createRule: "@request.body.user = @request.auth.id && story.user != @request.auth.id && " +
      "story.user.friends_via_friend.user ?= @request.auth.id && story.hidden.id != @request.auth.id && story.created > @yesterday",
    updateRule: "user = @request.auth.id && @request.body.story:isset = false && @request.body.user:isset = false",
  }));

  app.save(new Collection({
    type: "base",
    name: "story_hides",
    fields: [player("user"), player("hidden"), created],
    indexes: ["CREATE UNIQUE INDEX idx_story_hides ON story_hides (user, hidden)"],
    listRule: "user = @request.auth.id",
    viewRule: "user = @request.auth.id",
    createRule: "@request.body.user = @request.auth.id",
    deleteRule: "user = @request.auth.id",
  }));

  app.save(new Collection({
    type: "base",
    name: "notes",
    fields: [player("user"), { name: "text", type: "text", required: true, max: 60 }, updated],
    indexes: ["CREATE UNIQUE INDEX idx_notes_user ON notes (user)"],
    listRule: `user = @request.auth.id || (updated > @yesterday && ${FRIENDS})`,
    viewRule: `user = @request.auth.id || (updated > @yesterday && ${FRIENDS})`,
    createRule: "@request.body.user = @request.auth.id",
    updateRule: "user = @request.auth.id && @request.body.user:isset = false",
    deleteRule: "user = @request.auth.id",
  }));

  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.getByName("type").values = [...TYPES, "story"];
  app.save(messages);
}, (app) => {
  const messages = app.findCollectionByNameOrId("messages");
  messages.fields.getByName("type").values = TYPES;
  app.save(messages);
  for (const name of ["notes", "story_hides", "story_views", "stories"]) app.delete(app.findCollectionByNameOrId(name));
});
