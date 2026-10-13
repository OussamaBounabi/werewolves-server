/// <reference path="../pb_data/types.d.ts" />

/**
 * The only hook, and no game logic. A player copied from Firebase may bring his Firebase password once
 * (the game server's POST /api/auth/legacy-login), and only while his PocketBase password is still the
 * one the copy gave him: an old Firebase password must never replace a password he set since.
 *
 * PocketBase gives an account a new login key (tokenKey) when its password or e-mail changes — reset by
 * e-mail, changed by the player, set by a superuser, replaced by PocketBase when a Google sign-in links an
 * unverified account — whether this hook runs or not. So:
 * - a copied account (created with legacyKey = "copy") starts with a login key of its own, kept in
 *   legacyKey (hidden);
 * - the legacy login's write (legacyKey = "move") goes through only while the stored legacyKey is still
 *   the stored login key, and clears it. The game server sends it as a batch request, which reads the
 *   account inside the write transaction: a reset a moment earlier counts;
 * - a write that brings a new password or e-mail clears legacyKey itself. Two overlapping writes (a reset
 *   form sent twice) can make PocketBase save a copy of the account loaded before the other one, old login
 *   key included; that copy then carries no legacyKey.
 * legacyKey's pattern refuses "copy" and "move": without this hook, both fail instead of going ahead.
 */
onRecordCreate((e) => {
  if (e.record.getString("legacyKey") === "copy") {
    e.record.refreshTokenKey();
    e.record.set("legacyKey", e.record.tokenKey());
  }
  e.next();
}, "users");

onRecordUpdate((e) => {
  const stored = e.record.original();
  if (e.record.getString("legacyKey") === "move") {
    const key = stored.getString("legacyKey");
    if (!key || key !== stored.tokenKey()) throw new BadRequestError("already moved");
    e.record.set("legacyKey", "");
  } else if (
    e.record.getString("legacyKey") !== "" &&
    (e.record.getString("password:hash") !== stored.getString("password:hash") || e.record.email() !== stored.email())
  ) {
    e.record.set("legacyKey", "");
  }
  e.next();
}, "users");
