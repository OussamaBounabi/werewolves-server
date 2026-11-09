/**
 * support_messages.media: a picture or a video a player sends support with his message (his app keeps pictures to
 * 10 MB, videos to 30 seconds and 20 MB). Protected: only he (with a file token) and the admin app (through the game
 * server) can download it.
 */
migrate((app) => {
  const messages = app.findCollectionByNameOrId("support_messages");
  messages.fields.add(new FileField({
    name: "media",
    maxSelect: 1,
    maxSize: 20 * 1024 * 1024,
    mimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "video/mp4", "video/quicktime", "video/3gpp", "video/webm"],
    protected: true,
  }));
  app.save(messages);
}, (app) => {
  const messages = app.findCollectionByNameOrId("support_messages");
  messages.fields.removeByName("media");
  app.save(messages);
});
