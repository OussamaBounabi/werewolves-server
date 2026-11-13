/**
 * The Chat tab, phase 7 (2026-11-13): calls with more people — a group's, a clan's, people added to a call.
 *
 * calls.group / calls.clan: whose call it is (a group's rings its members; a clan's is open to all its members); a call
 * of two has neither (callee: the one called). call_people: who is in a call, written by the game server only
 * (src/calls.ts): ringing, in, left, declined, missed; talk: on the stage (a clan's call: 8 talk, the rest listen;
 * everyone else's: all talk); hand: a listener asks to talk. Whoever can see a call sees who is in it.
 */
const ME = "@request.auth.id";

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const calls = app.findCollectionByNameOrId("calls");
  calls.fields.getByName("callee").required = false;
  calls.fields.add(new RelationField({ name: "group", collectionId: app.findCollectionByNameOrId("groups").id, maxSelect: 1, cascadeDelete: true }));
  calls.fields.add(new RelationField({ name: "clan", collectionId: app.findCollectionByNameOrId("clans").id, maxSelect: 1, cascadeDelete: true }));
  app.save(calls);

  const people = new Collection({
    type: "base",
    name: "call_people",
    fields: [
      { name: "call", type: "relation", required: true, collectionId: calls.id, maxSelect: 1, cascadeDelete: true },
      { name: "user", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "state", type: "select", required: true, maxSelect: 1, values: ["ringing", "in", "left", "declined", "missed"] },
      { name: "talk", type: "bool" },
      { name: "hand", type: "bool" },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_call_people ON call_people (call, user)"],
  });
  app.save(people);
  people.listRule = `user = ${ME} || call.caller = ${ME} || call.callee = ${ME} || call.call_people_via_call.user ?= ${ME} || ` +
    `(call.clan != "" && call.clan.clan_members_via_clan.user ?= ${ME})`;
  people.viewRule = people.listRule;
  app.save(people);

  calls.listRule = `caller = ${ME} || callee = ${ME} || call_people_via_call.user ?= ${ME} || (clan != "" && clan.clan_members_via_clan.user ?= ${ME})`;
  calls.viewRule = calls.listRule;
  app.save(calls);
}, (app) => {
  const calls = app.findCollectionByNameOrId("calls");
  calls.listRule = calls.viewRule = "caller = @request.auth.id || callee = @request.auth.id";
  app.save(calls);
  app.delete(app.findCollectionByNameOrId("call_people"));
  calls.fields.removeByName("group");
  calls.fields.removeByName("clan");
  calls.fields.getByName("callee").required = true;
  app.save(calls);
});
