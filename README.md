# PlayRoom game server

The [Colyseus](https://docs.colyseus.io/) server of PlayRoom: the game rooms (werewolf, rummy, domino,
ludo, guess, imposter, mimic), the presence room, and the HTTP API the apps use. Players log in with
Firebase Auth. Their data lives in a self-hosted PocketBase on the same VPS: see
[`pocketbase/README.md`](pocketbase/README.md) for its collections, their rules, and what the apps do
with them.

## Usage

```
npm ci
cp .env.example .env    # then fill it in (below)
npm start               # tsx watch src/index.ts; production runs tsx src/index.ts under systemd (one process)
```

Open http://localhost:2567 for the playground, or /monitor for the monitor (not in production).

Without the Firebase and PocketBase settings, players join as guests and nothing is recorded. That's
how the tests and the local bots run.

## Settings (`.env`)

`.env` sits next to `package.json`. It is git-ignored: this repository is public, so no secret goes
into it. `.env.example` lists the variables.

| Variable | What |
|---|---|
| `FIREBASE_PROJECT_ID` | the Firebase project's id (Firebase console → Project settings → General). The server checks the players' Firebase ID tokens with it. No key or service account needed. |
| `POCKETBASE_URL` | PocketBase as the server reaches it: `http://127.0.0.1:8090` |
| `POCKETBASE_SUPERUSER_EMAIL`, `POCKETBASE_SUPERUSER_PASSWORD` | the superuser the server (and the admin scripts) sign in as. Give the server its own superuser, not yours. |
| `ADMIN_EMAILS` | the admin app's e-mails, comma-separated: god view in werewolf rooms, `/api/admin/*` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | in-room voice |
| `LIVEKIT_API_URL` | optional: where the game server itself calls LiveKit (`http://127.0.0.1:7880` on the same machine), instead of the public `LIVEKIT_URL` the apps join at |
| `FIREBASE_SERVICE_ACCOUNT` | the migration script only: the service account's JSON, if not in `service-account.json` |

## HTTP API

Account endpoints take the app's Firebase ID token as `Authorization: Bearer <token>`, as before.

| Endpoint | What |
|---|---|
| `GET /api/rooms`, `/api/<game>/rooms`, `/api/room-counts`, `/api/rooms/:roomId` | room lists (`room-counts` also says how many players are `online`) |
| `GET /api/missions` | the missions and the current day/week keys |
| `POST /api/missions/claim` `{ id }` | a mission's reward |
| `POST /api/avatars/buy` `{ id }`, `POST /api/frames/buy` `{ id }` | the store |
| `POST /api/profile` `{ name?, avatar?, frame?, username? }` | the player's own profile: the name once a day, free or owned avatars and frames, a username if he has none |
| `POST /api/auth/exchange` `{ idToken }` | the app's Firebase ID token for a PocketBase token of the same player, good for an hour: `{ token, expires, record }`. His PocketBase account is made at his first. |
| `GET /api/admin/rooms` | admins only |
| `GET /api/guess/catalog`, `POST /api/mimic/clip`, `GET /api/mimic/clip/…` | game data |

The rooms take the Firebase ID token as `idToken` in their join options. A token that isn't a valid
Firebase ID token is refused with 4401 "auth". The `presence` room, joined by every app while it's
open, is how the server knows who is online.

## Structure

- `src/index.ts`: entry point. Clears stale presence, starts the server and the welcome gifts.
- `src/app.config.ts`: the rooms, the HTTP routes, express middleware
- `src/accounts.ts`: checks Firebase ID tokens, and is the only file that talks to PocketBase (the token exchange, accounts, rewards, store, missions, presence writes)
- `src/presence.ts`, `src/rooms/PresenceRoom.ts`: who is online and in which room
- `src/rooms/*Room.ts`: the games
- `pocketbase/pb_migrations/`: the PocketBase collections and their access rules
- `scripts/`: admin tools and the Firebase migration
- `test/`: mocha tests

## Tests

Run them one file at a time. Running them together fails.

```
npx mocha -r tsx test/rummy.test.ts --exit --timeout 60000
```

- `test/WerewolfRoom.test.ts` takes about 11 minutes.
- `test/pocketbase.test.ts` runs a real PocketBase built from `pocketbase/pb_migrations`, with a
  stand-in for Firebase Auth. It tests the access rules, the token exchange, everything the server
  writes, and the Firebase copy. Point it at the
  [PocketBase executable](https://github.com/pocketbase/pocketbase/releases), or it is skipped:
  `POCKETBASE_BIN=/path/to/pocketbase npx mocha -r tsx test/pocketbase.test.ts --exit --timeout 60000`

## Admin scripts

They use the PocketBase superuser from `.env` (no Firebase setting needed). On the VPS, or anywhere with
`POCKETBASE_URL=https://pb.werewolf-server.duckdns.org`.

- `npx tsx scripts/grant-coins.ts <username> <coins> <diamonds>`: negative numbers take away, but
  never below 0
- `npx tsx scripts/grant-coins.ts --all <coins> <diamonds> [--dry]`
- `npx tsx scripts/grant-avatars.ts <email>`: every avatar and frame for sale
- `npx tsx scripts/set-vip.ts <e-mail | username> [off]`

## PocketBase on the VPS

1. Download PocketBase 0.40.5 (linux amd64) from its GitHub releases, e.g. to `/opt/pocketbase/pocketbase`.
2. Run it under systemd, listening on localhost only, with this repository's migrations:
   ```
   /opt/pocketbase/pocketbase serve --http 127.0.0.1:8090 --dir /var/lib/pocketbase \
     --migrationsDir /path/to/werewolves-server/pocketbase/pb_migrations --automigrate=false --dev=false
   ```
   It applies new migration files when it starts. Restart it after pulling new migrations.
3. Create two superusers: one for you (the dashboard) and one for the game server (`.env`):
   `/opt/pocketbase/pocketbase superuser upsert <email> <password> --dir /var/lib/pocketbase`
4. HTTPS: proxy `https://pb.werewolf-server.duckdns.org` to `127.0.0.1:8090`. If the proxy is nginx:
   - allow request bodies up to 2 MB (voice messages);
   - for realtime (SSE): `proxy_http_version 1.1`, `proxy_set_header Connection ''`,
     `proxy_buffering off`, `proxy_read_timeout 360s`.
5. In the dashboard (`https://pb.werewolf-server.duckdns.org/_/`), under Settings:
   - **Application URL:** `https://pb.werewolf-server.duckdns.org`
   - **Trusted proxy:** add the header your proxy sets (`X-Forwarded-For`)
   - **Backups:** a daily cron
   - **Rate limits:** if you turn them on, add `127.0.0.1` to the excluded IPs. The game server writes
     for every player from there.
   - **Mail settings:** leave them off. Sign-up, login and password resets stay on Firebase Auth, so
     PocketBase has nothing to send.
6. Mail can still go out if the VPS has a `sendmail` program: PocketBase falls back to it for two
   endpoints that stay open, even with logins off. Block both at the proxy, so nobody can make it send
   mail. With nginx (a collection can be named by its id too, hence `[^/]+`):
   ```
   location ~* ^/api/collections/[^/]+/request-(verification|email-change) { return 403; }
   ```

## Moving from Firebase

Firebase Auth stays: players keep their logins. Their data moves from Firestore and the Realtime
Database to PocketBase. The order, on the day:

1. Set up PocketBase (above). Fill in `.env` on the VPS: `FIREBASE_PROJECT_ID` and the PocketBase
   settings.
2. Put the Firebase service account on the machine that runs the copy: Firebase console → Project
   settings → Service accounts → Generate new private key, saved as `service-account.json` next to
   `package.json`. It's git-ignored. Delete it afterwards.
3. Check: `npx tsx scripts/migrate-from-firebase.ts --dry`. It reads everything and lists what it
   would copy and what's wrong: invalid or duplicate usernames, display names that aren't 3 to 16 of
   `[A-Za-z0-9_]`, a profile without an account… The copy fixes these, not you: a bad username is left
   empty (the player picks one), and a bad name is replaced by the player's username.
4. Stop writes to Firestore, so the copy is complete: take the old app versions out, or make the
   Firestore rules read-only.
5. Copy: `npx tsx scripts/migrate-from-firebase.ts`. It copies each Firebase Auth account's profile and
   data under the same id, but no password and no Google link: logins stay on Firebase. If it stops
   halfway, run it again: it carries on and never copies anything twice. It never updates what it
   already copied, so for a final copy of newer data, start from an empty PocketBase.
6. Restart the game server on this version. Release the apps that use PocketBase. Not before the copy:
   the copy never fills an account that already exists, and a player's first exchange makes his.
7. Players log in as before. At its first exchange (`/api/auth/exchange`), each app lands on its
   player's copied account. Someone who signed up after the copy gets a new account then.
8. Later:
   - delete `scripts/migrate-from-firebase.ts` and `scripts/firebaseImport.ts`;
   - revoke the key made for the copy (Google Cloud console → IAM → Service accounts → Keys);
   - turn off Firestore and the Realtime Database. Keep Firebase Auth and `firebase-admin`: they are
     the login.
