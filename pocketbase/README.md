# PocketBase: the apps' database

Player profiles, friends, chat, missions and the leaderboard live in a self-hosted
[PocketBase](https://pocketbase.io) (v0.40.5) on the game server's VPS. It replaces Firestore and the
Realtime Database. PocketBase is the database only: players sign up and log in with Firebase Auth, as
before.

| Who | Reaches it at |
|---|---|
| The apps | `https://pb.werewolf-server.duckdns.org` (PocketBase SDK: JS `pocketbase`, Dart `pocketbase`) |
| The game server | `http://127.0.0.1:8090`, signed in as a superuser |

The collections and their access rules are the migration files in [`pb_migrations/`](pb_migrations).
PocketBase applies them when it starts. To change a collection, add a new migration file here. There
are no hooks: PocketBase holds no game logic.

**Logins.** Nobody logs in to PocketBase or signs up on it: password, OAuth2 and one-time-code logins
are off. An app gets its PocketBase token from the game server, for its Firebase ID token
(`POST /api/auth/exchange`, below). The token is good for an hour, and the app exchanges again when it
expires.

**Who writes what.** The apps write directly only what a player may change himself: friend requests
and friendships, messages, read markers and reports, and deleting his account. Everything else goes
through the game server: accounts, XP, coins, diamonds, stats, purchases, missions, the welcome gift,
presence, the room a player is in, his name, avatar and frame. The game server writes as a superuser.

**Dates.** `created` is PocketBase's own date, in server time (`"2026-10-12 21:04:05.123Z"`). Rows
copied from Firebase also carry their original date in `firebaseAt`. Show `firebaseAt || created`.
Sort, and count what's unread, by `created`: the copy inserted Firebase's rows in their original
order, so this gives the same order as before.

## From Firebase to PocketBase

| Firebase | PocketBase |
|---|---|
| Auth (e-mail + password, Google) | stays on Firebase Auth |
| `users/{uid}` | `users`, id = the Firebase uid |
| `users/{uid}/private/info` | `private_info`, id = uid |
| `users/{uid}/missions/{period}` | `missions`, id = `<uid>_<period>` |
| `users/{uid}/friends/{fid}` | `friends` (`user` = uid, `friend` = fid): one row per side, as before |
| `users/{uid}/chatReads/{fid}` | `chat_reads` (`user` = uid, `friend` = fid) |
| `usernames/{name}` | nothing: `users.username` is unique |
| `friendRequests/{from_to}` | `friend_requests` (`from`, `to`: unique pair) |
| `chats/{chatId}` | the `conversations` view (built from the messages, nothing to write) |
| `chats/{chatId}/messages/{id}` | `messages` (`from`, `to`), same id |
| `chats/{chatId}/voices/{id}` | the `voice` file of its message |
| `leaderboard/{week}/players/{uid}` | `leaderboard`, id = `<uid>_<week>` |
| `reports/{target_reporter}` | `reports` (`target`, `reporter`: unique pair) |
| Realtime Database `status/{uid}` | `presence`, id = uid, written by the game server |

## Collections

"Signed in" means any player with a valid PocketBase token (from the exchange). "Server" means only
superusers, which is the game server. Every relation to `users` has cascade delete: deleting an account
deletes everything of his.

### `users` (auth collection)

One per player, made by the game server the first time it sees him (his first exchange or profile
setup), or by the copy from Firebase.

| Field | Type | Notes |
|---|---|---|
| `id` | text | his Firebase uid (28 characters) |
| `email` | email | his Firebase e-mail, kept in step at each exchange. Other players never see it. |
| `emailVisibility` | bool | always false |
| `verified` | bool | Firebase's "e-mail verified" |
| `password` | password | a random one nobody knows: PocketBase wants one, and password login is off |
| `username` | text | unique, lowercase, `^[a-z0-9_]{3,16}$`; empty for a new player until he picks one |
| `name` | text | display name: 3 to 16 of `[A-Za-z0-9_]` (the username's characters, any case); empty for a new player until he sets up his profile |
| `nameChangedAt` | date | the last name change (empty: never changed) |
| `avatar` | number | the avatar worn (0 = none yet; 103 and 104 are free for everyone) |
| `frame` | number | the frame worn, 0 = none |
| `avatars` | json | avatar ids owned, e.g. `[101, 601]` |
| `frames` | json | frame ids owned |
| `xp`, `coins`, `diamonds` | number | never below 0 |
| `rankPoints` | number | |
| `stats` | json | `{ games, wins, losses, minutes, wolfGames, wolfWins, villageGames, villageWins, soloGames, soloWins, roles: { <role>: { games, wins } } }` (null until his welcome gift, a few seconds after his first exchange) |
| `room` | text | the game room he's in, "" if none (the server keeps it; the chat rule uses it) |
| `vip` | bool | a VIP werewolf host picks his own role |
| `welcomeGift` | bool | the server gives 10,000 coins and 1,000 diamonds once, within 10 s of the account's creation |
| `createdAt` | date | when the account was made (Firebase's date for copied players) |
| `created`, `updated` | autodate | |

Rules:
- **list / view:** signed in. A player sees his own e-mail, nobody else's.
- **create / update:** server only.
- **delete:** his own account.
- **Logins:** none. Password, OAuth2, one-time-code and MFA logins are off. Tokens come from the game
  server's exchange.
- Name, avatar, frame, and a new player's first username go through the game server's
  `POST /api/profile` (below).

### `private_info` — server writes, owner reads

| Field | Type | Notes |
|---|---|---|
| `id` | text | = the player's id |
| `user` | relation → users | |
| `email` | text | his Firebase e-mail, like `users.email` |
| `provider` | select | `password` \| `google.com`: his Firebase sign-in when the account was made |
| `birthDate` | text | `YYYY-MM-DD`, old accounts only |
| `createdAt` | date | |

The server creates it with his account. Read it with `getOne(myId)`.

### `friend_requests`

| Field | Type | Notes |
|---|---|---|
| `from`, `to` | relation → users | unique pair |
| `firebaseAt` | date | copied rows only |
| `created` | autodate | |

- **list / view:** the two players.
- **create:** `from` = me, not to myself, and not if we're already friends.
- **delete:** either player (cancel, decline, accept).

### `friends`

| Field | Type | Notes |
|---|---|---|
| `user`, `friend` | relation → users | unique pair; a friendship is two rows, (me, him) and (him, me) |
| `firebaseAt` | date | the Firebase `since`, on copied rows |
| `created` | autodate | "friends since" on new rows |

- **list / view:** both players.
- **create:** only the player who received a pending request. He creates both rows, in the same
  batch that deletes the request.
- **delete:** either player (unfriend: delete both rows).

### `messages`

| Field | Type | Notes |
|---|---|---|
| `id` | text | Firestore's id on copied messages |
| `from`, `to` | relation → users | |
| `type` | select | `text` (or empty), `invite`, `voice`, `deleted` (its writer deleted it for both players: only this mark is left) |
| `text` | text | required, 1–500 characters; a voice message's fallback line, e.g. "🎤 Voice message (0:07)" |
| `roomId`, `roomHost` | text | invite: required `roomId` |
| `seconds` | number | voice: 1–60 |
| `wave` | text | voice: up to 64 digits |
| `voice` | file | voice: the audio (AAC in .m4a), up to 600 KB, required for a voice message, refused on others. Protected: download it with a file token. |
| `firebaseAt` | date | the Firebase `at`, on copied messages |
| `created` | autodate | when it was sent (server time) |

- **list / view:** sender and recipient.
- **create:** `from` = me; `to` is my friend; and we're not both in the same game room (anti-cheat).
- **update:** only its writer, and only to delete it for everyone: `type` = `"deleted"` with `text` = `"-"`
  (send `voice: null`, `wave: ""`, `seconds: 0`, `roomId: ""`, `roomHost: ""` with it). Once: a mark can't be
  changed again. `from`, `to` and `firebaseAt` can't be sent.
- **delete:** nobody. The mark stays, so the other player sees that a message was removed.

### `chat_reads`

| Field | Type | Notes |
|---|---|---|
| `user`, `friend` | relation → users | unique pair: "`user` read his chat with `friend`" |
| `at` | autodate | updated on every write: when he last read it (server time) |

- **list / view:** `user`, and `friend` too (that's how `friend` knows his messages were seen).
- **create:** `user` = me, `friend` is my friend.
- **update:** mine. Send an empty update (`update(id, {})`) to mark the chat read now.
- **delete:** mine.

### `conversations` (view, read-only)

One row per friendship, from my side: the conversation list and its badges in one request.

| Field | Type | Notes |
|---|---|---|
| `id` | text | the `friends` row's id |
| `user` | relation → users | me |
| `friend` | relation → users | |
| `lastMessage` | text | the last message's text (null if we never wrote) |
| `lastFrom` | relation → users | who sent it |
| `lastType` | select | its type |
| `updatedAt` | text | when it was sent (its `firebaseAt` or `created`), "" if no message |
| `unread` | number | his messages after my `chat_reads.at`, 99 at most |
| `seen` | bool | the last message is mine and he has read it |

- **list / view:** `user` = me. A view has no realtime events: re-read it when `messages` or
  `chat_reads` change.

### `missions` — server writes, owner reads

| Field | Type | Notes |
|---|---|---|
| `id` | text | `<uid>_<period>`, e.g. `abc…_d-2026-10-12` |
| `user` | relation → users | |
| `period` | text | `d-YYYY-MM-DD` (day) or `w-YYYY-MM-DD` (week starting Monday), Algeria time |
| `games`, `wins`, `wolfWins`, `villageWins`, `survived`, `minutes` | number | this period's progress |
| `claimed` | json | `{ "<mission id>": true }` |

`GET /api/missions` on the game server gives the missions, the current `day` and `week` keys, and
when they end. Read your progress with `getOne(`${me}_${day}`)` (404: nothing yet). Claim a reward
with `POST /api/missions/claim`.

### `leaderboard` — server writes, signed in reads

| Field | Type | Notes |
|---|---|---|
| `id` | text | `<uid>_<week>` |
| `week` | text | `w-YYYY-MM-DD` |
| `user` | relation → users | |
| `xp` | number | XP earned that week |
| `name`, `avatar`, `frame` | | his display name (up to 16 characters) and look when he last scored |

### `presence` — server writes, signed in reads

| Field | Type | Notes |
|---|---|---|
| `id` | text | = the player's id |
| `user` | relation → users | |
| `state` | select | `online` \| `in_game` \| `offline` |
| `game` | text | while `in_game`: werewolf, rummy, domino, ludo, guess, imposter, mimic |
| `at` | autodate | the last change |

No row means he's never been online since the move. Treat that as `offline`.

### `reports`

| Field | Type | Notes |
|---|---|---|
| `target`, `reporter` | relation → users | unique pair: one report per reporter per target |
| `reason` | select | `cheating`, `insults`, `bad_name`, `spam`, `afk`, `other` |
| `context` | text | up to 100 characters |
| `firebaseAt` | date | copied rows only |
| `created` | autodate | |

- **create:** `reporter` = me, `target` not me.
- **Reading reports:** nobody but superusers, through the PocketBase dashboard.

## What the app does

`pb` is the PocketBase SDK client for `https://pb.werewolf-server.duckdns.org`, and `server` is the
game server. The examples use the JS SDK; the Dart SDK has the same calls.

**Sign up, log in, forgot password, e-mail verification:** Firebase Auth, as before (e-mail +
password, Google).

**The PocketBase token:** after logging in, at each launch, and when it expires, exchange the Firebase
ID token for it:
```js
const idToken = await firebaseUser.getIdToken();
const res = await fetch(`${server}/api/auth/exchange`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }),
});
const { token, expires, record } = await res.json(); // expires: epoch ms, an hour from now
pb.authStore.save(token, record);
```
- The first exchange makes the player's account, with his Firebase uid as its id. Players copied from
  Firebase land on their copied account.
- If `record.username` is empty (a new player), show the profile screen, then
  `POST server/api/profile { username, name, avatar }`.
- Exchange again a few minutes before `expires`. Don't wait for an error: PocketBase doesn't answer 401
  to an expired token. It treats the request as a guest's, so lists come back empty and the rest is
  refused. `pb.authStore.isValid` turns false once the token has expired.
- The token can't be refreshed: `authRefresh()` gives the same one back.

| Answer | Meaning | Then |
|---|---|---|
| 200 | `{ token, expires, record }` | `pb.authStore.save(token, record)` |
| 400 | no `idToken` | |
| 401 | not a valid Firebase ID token (expired, another project's…), or a Firebase account without an e-mail | get a fresh ID token and try again, else log in again |
| 409 | `e-mail taken by another account`: another PocketBase account still has his e-mail (deleted from Firebase but not from PocketBase) | show a generic error. An admin deletes that account, or changes its e-mail, in the dashboard. |

**Delete my account:** `pb.collection("users").delete(me)` deletes everything of his on PocketBase.
Then delete the Firebase account (`firebaseUser.delete()`). If that fails (Firebase may want a recent
login), his next exchange makes him a new, empty account.

**The game server** takes the Firebase ID token, as before (not the PocketBase one):
- Send it as `idToken` when joining any room: `await firebaseUser.getIdToken()`, which renews it when
  needed.
- Send it as `Authorization: Bearer <ID token>` on `/api/missions/claim`, `/api/avatars/buy`,
  `/api/frames/buy`, `/api/profile` and `/api/admin/*`.
- A token that isn't a valid Firebase ID token is refused with 4401 "auth" (401 over HTTP).

**Profile:** `POST server/api/profile` with any of `{ name, avatar, frame, username }`. A field left
out, or null, stays as it is. It answers the profile as it is now:
`{ username, name, nameChangedAt, avatar, frame }`. Errors:

| Status | `error` |
|---|---|
| 400 | `name` (not 3 to 16 of `[A-Za-z0-9_]`), `username` (not 3 to 16 of `[a-z0-9_]`) |
| 409 | `too soon` (a name change within 24 h), `avatar` / `frame` (not owned), `username set`, `username taken` |

**Online / in a game:** while the app is open, stay in the presence room:
`client.joinOrCreate("presence", { idToken })`, and reconnect when the network comes back. While the
player is in a game room he shows `in_game`, with the game. Friends' presence:
- **Load:** `pb.collection("presence").getFullList({ filter: 'user.friends_via_friend.user ?= "<myId>"' })`.
- **Live:** `pb.collection("presence").subscribe("*", cb, { filter: <the same> })`.

**Friends:**
- **Request:** `friend_requests.create({ from: me, to: him })`.
- **Accept:** one batch:
  ```js
  const b = pb.createBatch();
  b.collection("friends").create({ user: me, friend: him });
  b.collection("friends").create({ user: him, friend: me });
  b.collection("friend_requests").delete(requestId);
  await b.send();
  ```
- **Decline / cancel:** delete the request.
- **Unfriend:** delete both `friends` rows in one batch.

**Chat:**
- **Send:** `messages.create({ from: me, to: him, text })`.
  - Invite: add `type: "invite", roomId, roomHost`.
  - Voice: `type: "voice", seconds, wave, voice: <File/Blob of the .m4a>` (multipart).
- **History:** `messages.getList(page, 30, { filter: '(from = "<me>" && to = "<him>") || (from = "<him>" && to = "<me>")', sort: "-created,-firebaseAt" })`.
- **Delete for everyone (mine only):** `messages.update(id, { type: "deleted", text: "-", voice: null, wave: "", seconds: 0, roomId: "", roomHost: "" })`.
  Show a `deleted` message as "This message was deleted"; the other app gets the change as a realtime `update`.
- **Play a voice message:** `pb.files.getURL(msg, msg.voice, { token: await pb.files.getToken() })`.
- **Mark read:** the first time `chat_reads.create({ user: me, friend: him })`, after that
  `chat_reads.update(id, {})`.
- **Seen:** my message is seen when his `chat_reads` row for me has `at >= message.created`.
- **Conversation list:** one request: `conversations.getFullList({ filter: 'updatedAt != ""', sort: "-updatedAt" })`.
- **Live:** subscribe to `messages` `*` and `chat_reads` `*` (the rules send only your own). On an
  event, re-read `conversations` or update the screen.

**Missions / leaderboard:**
- **This week's top:** `leaderboard.getList(1, 50, { filter: 'week = "<week>"', sort: "-xp" })`.
- **Missions:** `missions.getOne(`${me}_${day}`)` and `missions.getOne(`${me}_${week}`)`.

**Report:** `reports.create({ target, reporter: me, reason, context })`. A second report of the same
player is refused (400).
