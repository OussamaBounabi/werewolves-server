/// <reference path="../pb_data/types.d.ts" />

/**
 * The only hook, and no game logic: a player copied from Firebase keeps legacyAuth = true until he brings
 * his Firebase password (the game server's POST /api/auth/legacy-login). If his PocketBase password
 * changes first — reset by e-mail, changed by him, set by a superuser — that move is over, so his old
 * Firebase password can never replace the new one.
 *
 * - Any save with a new password stores legacyAuth = false.
 * - The game server's legacy login saves the Firebase password with legacyAuth = true ("this is the
 *   password from Firebase"). That save is refused unless the account is still waiting for it. The game
 *   server sends it in a batch request, which reads the account inside the write transaction, so a reset
 *   saved a moment earlier can't slip in between.
 *
 * Only a hook sees a password change: the API never shows the password hash, nor the tokenKey that
 * changes with it, not even to superusers. While a record is being saved with a new password, its
 * "password" field reads as that new password; otherwise it reads "".
 */
onRecordUpdate((e) => {
  if (e.record.getString("password") !== "") {
    if (e.record.getBool("legacyAuth") && !e.record.original().getBool("legacyAuth")) {
      throw new BadRequestError("already moved");
    }
    e.record.set("legacyAuth", false);
  }
  e.next();
}, "users");
