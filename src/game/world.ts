// Procedural world: planets, asteroids, black holes, coins.
// Deterministic from the room code seed so all players see the same map.
export type Hazard = {
  id: string;
  kind: "planet" | "asteroid" | "blackhole" | "star";
  x: number;
  y: number;
  radius: number;
  color: string;
};

export type CoinTier = "yellow" | "green" | "pink" | "red" | "blue" | "purple";

export type CoinDrop = {
  id: string;
  x: number;
  y: number;
  kind: "coin" | "diamond";
  value: number;
  tier: CoinTier;
  color: string;
};

export const GALAXY_SIZE = 90000;
export const SAFE_RADIUS = GALAXY_SIZE * 0.48;

// Higher value tiers
export const COIN_TIERS = [
  { tier: "yellow" as const, value: 50,    weight: 60, color: "oklch(0.90 0.22 95)"  },
  { tier: "green"  as const, value: 250,   weight: 22, color: "oklch(0.82 0.24 140)" },
  { tier: "pink"   as const, value: 1000,  weight: 12, color: "oklch(0.80 0.24 340)" },
  { tier: "red"    as const, value: 5000,  weight: 6,  color: "oklch(0.70 0.26 25)"  },
];
export const DIAMOND_TIERS = [
  { tier: "blue"   as const, value: 20, weight: 72, color: "oklch(0.82 0.20 235)" },
  { tier: "purple" as const, value: 80, weight: 28, color: "oklch(0.70 0.25 300)" },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickTier<T extends { weight: number }>(r: () => number, list: readonly T[]): T {
  const total = list.reduce((a, b) => a + b.weight, 0);
  let v = r() * total;
  for (const t of list) { v -= t.weight; if (v <= 0) return t; }
  return list[0];
}

export function generateHazards(seed: number): Hazard[] {
  const r = rng(seed);
  const out: Hazard[] = [];
  for (let i = 0; i < 60; i++) {
    const x = (r() - 0.5) * GALAXY_SIZE * 0.9;
    const y = (r() - 0.5) * GALAXY_SIZE * 0.9;
    const hue = Math.floor(r() * 60);
    out.push({ id: `star-${i}`, kind: "star", x, y, radius: 180 + r() * 260, color: `oklch(0.92 0.18 ${hue})` });
  }
  for (let i = 0; i < 540; i++) {
    const x = (r() - 0.5) * GALAXY_SIZE * 0.97;
    const y = (r() - 0.5) * GALAXY_SIZE * 0.97;
    const radius = 90 + r() * 320;
    const hue = Math.floor(r() * 360);
    out.push({ id: `planet-${i}`, kind: "planet", x, y, radius, color: `oklch(${0.5 + r() * 0.3} ${0.1 + r() * 0.2} ${hue})` });
  }
  for (let i = 0; i < 60; i++) {
    const x = (r() - 0.5) * GALAXY_SIZE * 0.9;
    const y = (r() - 0.5) * GALAXY_SIZE * 0.9;
    out.push({ id: `bh-${i}`, kind: "blackhole", x, y, radius: 70 + r() * 70, color: "#000" });
  }
  for (let i = 0; i < 1800; i++) {
    const x = (r() - 0.5) * GALAXY_SIZE;
    const y = (r() - 0.5) * GALAXY_SIZE;
    out.push({ id: `ast-${i}`, kind: "asteroid", x, y, radius: 22 + r() * 50, color: `oklch(${0.38 + r() * 0.18} 0.04 ${30 + r() * 40})` });
  }
  return out;
}

function makeCoin(r: () => number, id: string): CoinDrop {
  const x = (r() - 0.5) * GALAXY_SIZE;
  const y = (r() - 0.5) * GALAXY_SIZE;
  const isDiamond = r() < 0.06;
  if (isDiamond) {
    const t = pickTier(r, DIAMOND_TIERS);
    return { id, x, y, kind: "diamond", value: t.value, tier: t.tier, color: t.color };
  }
  const t = pickTier(r, COIN_TIERS);
  return { id, x, y, kind: "coin", value: t.value, tier: t.tier, color: t.color };
}

export function generateCoins(seed: number): CoinDrop[] {
  const r = rng(seed ^ 0xC0FFEE);
  const out: CoinDrop[] = [];
  for (let i = 0; i < 3500; i++) out.push(makeCoin(r, `c-${i}`));
  return out;
}

// Deterministic respawn batch keyed by time bucket — every client agrees.
export function generateCoinBatch(seed: number, bucket: number, count = 120): CoinDrop[] {
  const r = rng((seed ^ 0xC0FFEE) ^ (bucket * 0x9E3779B1));
  const out: CoinDrop[] = [];
  for (let i = 0; i < count; i++) out.push(makeCoin(r, `cb-${bucket}-${i}`));
  return out;
}

// Random spawn location inside the safe arena (used for entry & respawn).
export function randomSpawnInArena(): { x: number; y: number } {
  // uniform in a disc of radius SAFE_RADIUS * 0.85
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * SAFE_RADIUS * 0.85;
  return { x: Math.cos(t) * r, y: Math.sin(t) * r };
}
