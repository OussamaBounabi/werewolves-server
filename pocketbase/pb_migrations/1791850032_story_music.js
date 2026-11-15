/**
 * Stories with music (2026-11-14): a song from the phone (its file, 15 MB at most), where its 15 seconds start
 * (musicStart, in seconds) and its name (musicTitle): it plays with the story. Like the rest, fixed once posted.
 */
const FIXED = ["user", "kind", "media", "seconds", "overlay", "text", "color", "data"];
const AUDIO = [
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav",
  "audio/flac", "audio/x-flac", "audio/amr", "audio/3gpp", "audio/webm", "video/mp4", "video/3gpp",
];
const fixed = (fields) => "user = @request.auth.id && " + fields.map((f) => `@request.body.${f}:isset = false`).join(" && ");

migrate((app) => {
  const stories = app.findCollectionByNameOrId("stories");
  stories.fields.add(
    new FileField({ name: "music", maxSelect: 1, maxSize: 15 * 1024 * 1024, protected: true, mimeTypes: AUDIO }),
    new NumberField({ name: "musicStart", onlyInt: true, min: 0 }),
    new TextField({ name: "musicTitle", max: 120 }),
  );
  stories.updateRule = fixed([...FIXED, "music", "musicStart", "musicTitle"]);
  app.save(stories);
}, (app) => {
  const stories = app.findCollectionByNameOrId("stories");
  for (const f of ["music", "musicStart", "musicTitle"]) stories.fields.removeByName(f);
  stories.updateRule = fixed(FIXED);
  app.save(stories);
});
