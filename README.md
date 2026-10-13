# PlayRoom game server

The [Colyseus](https://docs.colyseus.io/) server of PlayRoom: the game rooms (werewolf, rummy, domino,
ludo, guess, imposter, mimic), the presence room, and the HTTP API the apps use. Player accounts live in
a self-hosted PocketBase on the same VPS: see [`pocketbase/README.md`](pocketbase/README.md) for its
collections, their rules, and what the apps do with them.

## Usage

```
npm ci
cp .env.example .env    # then fill it in (below)
npm start               # tsx watch src/index.ts; production runs tsx src/index.ts under systemd (one process)
```

Open http://localhost:2567 for the playground, or /monitor for the monitor (not in production).

Without the PocketBase settings, players join as guests and nothing is recorded. That's how the tests
and the local bots run.

## Settings (`.env`)

`.env` sits next to `package.json`. It is git-ignored: this repository is public, so no secret goes
into it. `.env.example` lists the variables.

| Variable | What |
|---|---|
| `POCKETBASE_URL` | PocketBase as the server reaches it: `http://127.0.0.1:8090` |
| `POCKETBASE_SUPERUSER_EMAIL`, `POCKETBASE_SUPERUSER_PASSWORD` | the superuser the server (and the admin scripts) sign in as. Give the server its own superuser, not yours. |
| `ADMIN_EMAILS` | the admin app's e-mails, comma-separated: god view in werewolf rooms, `/api/admin/*` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | in-room voice |
| `FIREBASE_WEB_API_KEY` | while moving from Firebase: the Firebase project's Web API key (Firebase console → Project settings → General). The legacy login checks e-mail players' passwords with it. |
| `FIREBASE_SERVICE_ACCOUNT` | the migration script only: the service account's JSON, if not in `service-account.json` |

## HTTP API

Account endpoints take the app's PocketBase token as `Authorization: Bearer <token>`.

| Endpoint | What |
|---|---|
| `GET /api/rooms`, `/api/<game>/rooms`, `/api/room-counts`, `/api/rooms/:roomId` | room lists |
| `GET /api/missions` | the missions and the current day/week keys |
| `POST /api/missions/claim` `{ id }` | a mission's reward |
| `POST /api/avatars/buy` `{ id }`, `POST /api/frames/buy` `{ id }` | the store |
| `POST /api/profile` `{ name?, avatar?, frame?, username? }` | the player's own profile: the name once a day, free or owned avatars and frames, a username if he has none |
| `POST /api/auth/legacy-login` `{ email, password }` | an e-mail player's first login after the move from Firebase (no token) |
| `GET /api/admin/rooms` | admins only |
| `GET /api/guess/catalog`, `POST /api/mimic/clip`, `GET /api/mimic/clip/…` | game data |

The rooms take the token as `idToken` in their join options. A token PocketBase doesn't accept is
refused with 4401 "auth". The `presence` room, joined by every app while it's open, is how the server
knows who is online.

## Structure

- `src/index.ts`: entry point. Clears stale presence, starts the server and the welcome gifts.
- `src/app.config.ts`: the rooms, the HTTP routes, express middleware
- `src/accounts.ts`: the only file that talks to PocketBase (accounts, rewards, store, missions, presence writes)
- `src/presence.ts`, `src/rooms/PresenceRoom.ts`: who is online and in which room
- `src/legacyLogin.ts`: e-mail players' first login after the move (delete it once everyone has moved)
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
- `test/pocketbase.test.ts` runs a real PocketBase built from `pocketbase/pb_migrations`. It tests the
  access rules, everything the server writes, and the Firebase copy. Point it at the
  [PocketBase executable](https://github.com/pocketbase/pocketbase/releases), or it is skipped:
  `POCKETBASE_BIN=/path/to/pocketbase npx mocha -r tsx test/pocketbase.test.ts --exit --timeout 60000`

## Admin scripts

They use the PocketBase superuser from `.env`. On the VPS, or anywhere with
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
   It applies new migration files when it starts. Restart it after pulling new ones.
3. Create two superusers: one for you (the dashboard) and one for the game server (`.env`):
   `/opt/pocketbase/pocketbase superuser upsert <email> <password> --dir /var/lib/pocketbase`
4. HTTPS: proxy `https://pb.werewolf-server.duckdns.org` to `127.0.0.1:8090`. If the proxy is nginx:
   - allow request bodies up to 2 MB (voice messages);
   - for realtime (SSE): `proxy_http_version 1.1`, `proxy_set_header Connection ''`,
     `proxy_buffering off`, `proxy_read_timeout 360s`.
5. In the dashboard (`https://pb.werewolf-server.duckdns.org/_/`), under Settings:
   - **Application URL:** `https://pb.werewolf-server.duckdns.org`
   - **Trusted proxy:** add the header your proxy sets (`X-Forwarded-For`)
   - **Mail settings:** your SMTP server, so "forgot password" e-mails go out; edit the reset e-mail
     template under Collections → users → Options
   - **Backups:** a daily cron
   - **Rate limits:** if you turn them on, add `127.0.0.1` to the excluded IPs. The game server checks
     every player's token from there.
6. Google sign-in. In Google Cloud Console (the Firebase project) → APIs & Services → Credentials,
   open the "Web client (auto created by Google Service)" OAuth client:
   - add the redirect URI `https://pb.werewolf-server.duckdns.org/api/oauth2-redirect`;
   - check that the OAuth consent screen is published.

   Then in the dashboard, under Collections → users → Options → OAuth2, enable it, add Google, and
   paste that client's ID and secret.

## Moving from Firebase

The order, on the day:

1. Set up PocketBase (above). Fill in `.env` on the VPS: the PocketBase settings and
   `FIREBASE_WEB_API_KEY`.
2. Put the Firebase service account on the machine that runs the copy: Firebase console → Project
   settings → Service accounts → Generate new private key, saved as `service-account.json` next to
   `package.json`. It's git-ignored. Delete it afterwards.
3. Check: `npx tsx scripts/migrate-from-firebase.ts --dry`. It reads everything and lists what it
   would copy and what's wrong: invalid or duplicate usernames, display names that aren't 3 to 16 of
   `[A-Za-z0-9_]`, a profile without an account… The copy fixes these, not you: a bad username is left
   empty (the player picks one), and a bad name is replaced by the player's username.
4. Stop writes to Firebase, so the copy is complete: take the old app versions out, or make the
   Firestore rules read-only.
5. Copy: `npx tsx scripts/migrate-from-firebase.ts`. If it stops halfway, run it again: it carries on
   and never copies anything twice. It never updates what it already copied, so for a final copy of
   newer data, start from an empty PocketBase.
6. Restart the game server on this version. Release the apps that use PocketBase.
7. E-mail players get their password back at their first login (`/api/auth/legacy-login`). Google
   players sign in with Google and find their account.
8. Later, when the players have moved:
   - delete `src/legacyLogin.ts` and its route, and `FIREBASE_WEB_API_KEY`;
   - delete `scripts/migrate-from-firebase.ts`, `scripts/firebaseImport.ts` and the `firebase-admin`
     dev dependency;
   - shut the Firebase project down.

   Until then, an e-mail player who hasn't logged in can still move.
