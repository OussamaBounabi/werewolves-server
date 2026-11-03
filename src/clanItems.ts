/**
 * What the clan store sells: each item's id (slot.name, the app draws it by that id) and starter price. The owner may
 * change a price or hide an item (settings().clanStore). A price of 0 is free for every Pro clan.
 */
export type ClanPrice = { coins: number; diamonds: number };

const coins = (n: number): ClanPrice => ({ coins: n, diamonds: 0 });
const diamonds = (n: number): ClanPrice => ({ coins: 0, diamonds: n });

const numbered = (slot: string, from: number, to: number, price: (n: number) => ClanPrice) =>
  Array.from({ length: to - from + 1 }, (_, i) => [`${slot}.${from + i}`, price(from + i)] as const);
const named = (slot: string, names: string[], price: (name: string) => ClanPrice) =>
  names.map((name) => [`${slot}.${name}`, price(name)] as const);

export const CLAN_COLORS = ["gold", "aurora", "inferno", "moon", "ice", "obsidian", "venom", "rose"];
export const CLAN_SHAPES = ["crest", "wolf", "crown", "flame", "moon", "gem", "wings", "castle", "burst", "trophy", "pennant", "octagon"];

// The emblem effects that move little (rings, sparks, ribbons) are coins; the big ones diamonds; the combinations most.
const FX_COINS = [1, 2, 3, 4, 5, 6, 18, 19];
const FX_BEST = [21, 22, 23, 24];

/** Every item a clan may buy alone, in the store's order. */
export const CLAN_ITEMS: Record<string, ClanPrice> = Object.fromEntries([
  ...named("color", CLAN_COLORS, (c) => (c === "gold" ? coins(0) : coins(5000))),
  ...numbered("fx", 1, 24, (n) => (FX_BEST.includes(n) ? diamonds(200) : FX_COINS.includes(n) ? coins(10000) : diamonds(100))),
  ...named("shape", CLAN_SHAPES, () => coins(3000)),
  ...numbered("tag", 1, 17, (n) => (n === 1 ? coins(0) : coins(5000))),
  ...numbered("badge", 1, 15, (n) => (n === 1 ? coins(0) : coins(5000))),
  ...numbered("row", 1, 12, () => coins(8000)),
  ...numbered("card", 1, 5, () => coins(5000)),
  ...numbered("banner", 1, 12, () => diamonds(100)),
  ...numbered("bubble", 1, 11, () => coins(8000)),
  ...numbered("voice", 1, 4, () => coins(5000)),
  ...numbered("pin", 1, 4, () => coins(5000)),
  ...numbered("lounge", 1, 6, () => diamonds(200)),
  ...numbered("wallet", 1, 7, () => coins(5000)),
  ...numbered("chest", 1, 6, () => coins(8000)),
  ...numbered("enter", 1, 8, () => diamonds(150)),
  ...numbered("win", 1, 8, () => diamonds(150)),
]);

const pack = (id: string, color: string, fx: number, shape: string, badge: number, tag: number, row: number, bubble: number, voice: number, pin: number) => [
  id,
  [
    `color.${color}`, `fx.${fx}`, `shape.${shape}`, `badge.${badge}`, `tag.${tag}`, `row.${row}`, `bubble.${bubble}`, `voice.${voice}`, `pin.${pin}`,
    `banner.${id}`, `page.${id}`, `lounge.${id}`, // (made for the pack: not sold alone)
  ],
] as [string, string[]];

/** The five packs: one look for the clan's page, banner, chat, pinned messages and lounge. */
export const CLAN_PACKS: Record<string, string[]> = Object.fromEntries([
  pack("royal_gold", "gold", 7, "crest", 4, 2, 3, 2, 1, 1),
  pack("aurora_neon", "aurora", 2, "octagon", 8, 4, 2, 5, 2, 3),
  pack("inferno", "inferno", 10, "flame", 9, 11, 4, 7, 3, 2),
  pack("moon_wolf", "moon", 11, "wolf", 5, 8, 5, 4, 2, 1),
  pack("rose_royale", "rose", 8, "burst", 14, 15, 7, 10, 1, 2),
]);
export const PACK_PRICE = diamonds(800);

/** Every id the store knows: the items, then the packs. */
export const CLAN_STORE_IDS = [...Object.keys(CLAN_ITEMS), ...Object.keys(CLAN_PACKS).map((p) => `pack.${p}`)];

/** An item's usual price. */
export const clanPriceOf = (id: string): ClanPrice | undefined => (id.startsWith("pack.") ? (CLAN_PACKS[id.slice(5)] ? PACK_PRICE : undefined) : CLAN_ITEMS[id]);

/** What a clan may wear in each place: an item's id starts with its place. */
export const slotOf = (id: string) => id.split(".")[0];
export const CLAN_SLOTS = ["color", "fx", "shape", "tag", "badge", "row", "card", "banner", "page", "bubble", "voice", "pin", "lounge", "wallet", "chest", "enter", "win"];
