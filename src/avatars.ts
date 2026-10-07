/**
 * The avatar collection (the apps have the pictures): id → rarity, which sets the price. Two of them are free,
 * everyone has them (new accounts pick one; old profiles' 0–4 show the first); 100 is the bots' robot.
 */
export type Rarity = "common" | "rare" | "epic" | "legendary" | "animated";

export const PRICES: Record<Rarity, { amount: number; currency: "coins" | "diamonds" }> = {
  common: { amount: 500, currency: "coins" }, // the hoodie friends
  rare: { amount: 1500, currency: "coins" }, // heroes, animals
  epic: { amount: 50, currency: "diamonds" }, // werewolves, the village's roles
  legendary: { amount: 120, currency: "diamonds" }, // dragons, the unicorn, the wizard, the knight
  animated: { amount: 300, currency: "diamonds" }, // characters that move (201+)
};

/** Characters that move (animated WebP in the apps): the red werewolf, the straw-hat boy… */
export const ANIMATED = [201, 202];

const run = (from: number, to: number, rarity: Rarity) =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, rarity]));

export const AVATARS: Record<number, Rarity> = {
  ...run(101, 108, "common"),
  ...run(109, 126, "rare"),
  ...run(127, 142, "epic"),
  ...run(143, 147, "legendary"),
  ...Object.fromEntries(ANIMATED.map((id) => [id, "animated"])),
};

export const ROBOT = 100;
export const FREE_AVATARS = [103, 104];
export const avatarIds = Object.keys(AVATARS).map(Number);

/** A character at random, what players without an account wear (test clients): animated ones too, to see them. */
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
