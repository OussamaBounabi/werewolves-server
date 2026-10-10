/**
 * The avatar collection (the apps have the pictures): id → rarity, which sets the price. Two of them are free,
 * everyone has them (new accounts pick one; old profiles' 0–4 show the first); 100 is the bots' robot.
 * The first collection's 127–147 and its animated 201, 202 are retired: no longer sold (so not listed here);
 * whoever bought one keeps it.
 */
export type Rarity = "common" | "rare" | "legendary" | "mythic";

export const PRICES: Record<Rarity, { amount: number; currency: "coins" | "diamonds" }> = {
  common: { amount: 500, currency: "coins" }, // the hoodie friends, the family and the neighbours
  rare: { amount: 1500, currency: "coins" }, // heroes, each game's character, animals
  legendary: { amount: 120, currency: "diamonds" }, // the legends
  mythic: { amount: 300, currency: "diamonds" }, // gods and monsters, who move (animated WebP in the apps)
};

const run = (from: number, to: number, rarity: Rarity) =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, rarity]));

export const AVATARS: Record<number, Rarity> = {
  ...run(101, 108, "common"),
  ...run(109, 126, "rare"),
  ...run(301, 318, "common"),
  ...run(401, 418, "rare"),
  ...run(501, 507, "legendary"),
  ...run(601, 605, "mythic"),
};

export const ROBOT = 100;
export const FREE_AVATARS = [103, 104];
export const avatarIds = Object.keys(AVATARS).map(Number);

/** A character at random, what players without an account wear (test clients): mythic ones too, to see them move. */
export const randomAvatar = () => avatarIds[Math.floor(Math.random() * avatarIds.length)];

/** Animated frames around the avatar, sold separately (the apps draw them); 0 is none. */
export const FRAMES: Record<number, { amount: number; currency: "coins" | "diamonds" }> = {
  1: { amount: 5000, currency: "coins" }, // neon pulse
  2: { amount: 150, currency: "diamonds" }, // rainbow
  3: { amount: 200, currency: "diamonds" }, // golden shine
  4: { amount: 250, currency: "diamonds" }, // lightning
};
export const frameIds = Object.keys(FRAMES).map(Number);

/** A frame at random, or none: what players without an account wear (test clients). */
export const randomFrame = () => Math.floor(Math.random() * (frameIds.length + 1));
