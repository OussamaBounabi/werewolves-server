/**
 * The avatar collection (the apps have the pictures): id → rarity, which sets the price.
 * 0 is the paw everyone has (old profiles' 1–4 show it too); 100 is the robot the bots wear, not for sale.
 */
export type Rarity = "common" | "rare" | "epic" | "legendary";

export const PRICES: Record<Rarity, { amount: number; currency: "coins" | "diamonds" }> = {
  common: { amount: 500, currency: "coins" }, // the hoodie friends
  rare: { amount: 1500, currency: "coins" }, // heroes, animals
  epic: { amount: 50, currency: "diamonds" }, // werewolves, the village's roles
  legendary: { amount: 120, currency: "diamonds" }, // dragons, the unicorn, the wizard, the knight
};

const run = (from: number, to: number, rarity: Rarity) =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, rarity]));

export const AVATARS: Record<number, Rarity> = {
  ...run(101, 108, "common"),
  ...run(109, 126, "rare"),
  ...run(127, 142, "epic"),
  ...run(143, 147, "legendary"),
};

export const ROBOT = 100;
export const avatarIds = Object.keys(AVATARS).map(Number);
