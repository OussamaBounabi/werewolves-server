/// <reference path="../pb_data/types.d.ts" />

/**
 * The only hook, and no game logic: a player copied from Firebase keeps legacyAuth = true until he brings
 * his Firebase password (the game server's POST /api/auth/legacy-login). If his PocketBase password
 * changes first — reset by e-mail, changed by him, set by a superuser, or replaced by PocketBase itself
 * when a Google sign-in links his unverified account — that move is over, so his old Firebase password
 * can never replace the new one.
 *
 * - legacyAuth never goes from false back to true (not even from a superuser, e.g. a dashboard form saved
 *   with stale values).
 * - Any save with a new password stores legacyAuth = false. The game server's legacy login saves the
 *   Firebase password with legacyAuth = true ("the password from Firebase"): by the rule above, that save
 *   is refused unless the account is still waiting for it. The game server sends it in a batch request,
 *   which reads the account inside the write transaction, so a reset saved a moment earlier can't slip in.
 * - A save that gave the account a new tokenKey (PocketBase does that whenever the password or the
 *   e-mail changes, whatever the path) ends the move too.
 *
 * Only a hook sees a password change: the API never shows the password hash, nor the tokenKey, not even
 * to superusers. While a record is being saved with a new password, its "password" field reads as that
 * new password, otherwise ""; its tokenKey only changes during the write itself.
 */
onRecordUpdate((e) => {
  if (e.record.getBool("legacyAuth") && !e.record.original().getBool("legacyAuth")) {
    throw new BadRequestError("already moved");
  }
  if (e.record.getString("password") !== "") e.record.set("legacyAuth", false); // in the same write
  const tokenKey = e.record.original().tokenKey();
  e.next();
  if (e.record.getBool("legacyAuth") && e.record.tokenKey() !== tokenKey) {
    e.record.set("legacyAuth", false);
    e.app.save(e.record); // (same transaction as the write that changed it)
  }
}, "users");
