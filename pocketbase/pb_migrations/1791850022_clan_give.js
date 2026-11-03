/** clan_wallet: kind give, a member putting his own coins and diamonds in (user: who). The game server writes it. */
migrate((app) => {
  const wallet = app.findCollectionByNameOrId("clan_wallet");
  wallet.fields.getByName("kind").values = ["week", "pay", "buy", "give"];
  app.save(wallet);
}, (app) => {
  const wallet = app.findCollectionByNameOrId("clan_wallet");
  wallet.fields.getByName("kind").values = ["week", "pay", "buy"];
  app.save(wallet);
});
