/**
 * The Pro clan and its store (2026-11-02). Only the game server writes these clan fields.
 * - clans.pro, proEnds: Pro now, and when its notice ends; sponsor, sponsorSince: the member keeping it Pro.
 * - clans.owned, equipped: what it bought, and what it wears in each place.
 * - clans.pinned2: the second pinned line; announcedOn: the day of its last announcement.
 * - clan_messages: kinds pro, sponsor, announce, poll, event (the server's). A poll's answers and votes are in its data.
 * - clan_wallet: kind buy (note: the item).
 * - clan_events: the clan's calendar, for its members to read.
 */
migrate((app) => {
  const clans = app.findCollectionByNameOrId("clans");
  const users = app.findCollectionByNameOrId("users");
  clans.fields.add(new BoolField({ name: "pro" }));
  clans.fields.add(new DateField({ name: "proEnds" }));
  clans.fields.add(new RelationField({ name: "sponsor", collectionId: users.id, maxSelect: 1, cascadeDelete: false }));
  clans.fields.add(new DateField({ name: "sponsorSince" }));
  clans.fields.add(new JSONField({ name: "owned", maxSize: 20000 }));
  clans.fields.add(new JSONField({ name: "equipped", maxSize: 4000 }));
  clans.fields.add(new TextField({ name: "pinned2", max: 200 }));
  clans.fields.add(new TextField({ name: "announcedOn", max: 10 }));
  app.save(clans);

  const lines = app.findCollectionByNameOrId("clan_messages");
  lines.fields.getByName("kind").values = ["text", "voice", "room", "joined", "left", "leader", "pro", "sponsor", "announce", "poll", "event"];
  app.save(lines);

  const wallet = app.findCollectionByNameOrId("clan_wallet");
  wallet.fields.getByName("kind").values = ["week", "pay", "buy"];
  app.save(wallet);

  const myClan = '@request.auth.clan != "" && clan = @request.auth.clan';
  app.save(new Collection({
    type: "base",
    name: "clan_events",
    fields: [
      { name: "clan", type: "relation", required: true, collectionId: clans.id, maxSelect: 1, cascadeDelete: true },
      { name: "title", type: "text", required: true, max: 80 },
      { name: "at", type: "date", required: true },
      { name: "by", type: "relation", collectionId: users.id, maxSelect: 1, cascadeDelete: false },
    ],
    indexes: ["CREATE INDEX idx_clan_events_clan ON clan_events (clan, at)"],
    listRule: myClan,
    viewRule: myClan,
  }));
}, (app) => {
  app.delete(app.findCollectionByNameOrId("clan_events"));
  const wallet = app.findCollectionByNameOrId("clan_wallet");
  wallet.fields.getByName("kind").values = ["week", "pay"];
  app.save(wallet);
  const lines = app.findCollectionByNameOrId("clan_messages");
  lines.fields.getByName("kind").values = ["text", "voice", "room", "joined", "left", "leader"];
  app.save(lines);
  const clans = app.findCollectionByNameOrId("clans");
  for (const name of ["pro", "proEnds", "sponsor", "sponsorSince", "owned", "equipped", "pinned2", "announcedOn"]) clans.fields.removeByName(name);
  app.save(clans);
});
