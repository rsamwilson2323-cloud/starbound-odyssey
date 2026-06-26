// 1000 ships, progressive pricing. Index 0 is the free starter.
export type Ship = {
  id: number;
  name: string;
  price: number;
  fireRate: number;
  bulletDmg: number;
  bulletSpeed: number;
  bulletColor: string;
  hp: number;
  maxSpeed: number;
  accel: number;
  shape: number;
  size: number;
};

const PREFIX = [
  "Scout","Dart","Falcon","Comet","Wraith","Raven","Lance","Spark","Echo","Pulse",
  "Talon","Storm","Vortex","Cipher","Phantom","Stinger","Saber","Reaver","Striker","Nomad",
  "Banshee","Specter","Harbinger","Sentinel","Onyx","Aegis","Vanguard","Tempest","Hydra","Kraken",
  "Behemoth","Titan","Nova","Pulsar","Quasar","Eclipse","Halo","Zenith","Apex","Oblivion",
  "Cataclysm","Singularity","Eternity","Genesis","Paragon","Sovereign","Imperator","Celestial","Voidlord","Stellaris",
];
const SUFFIX = ["Mk","X","Z","Pro","Elite","Prime","Omega","Alpha","Nyx","Ion","Flux","Rift","Drift","Edge","Wing","Core","Halo","Storm","Vex","Zero"];

function shipName(i: number): string {
  if (i < PREFIX.length) return PREFIX[i];
  const a = PREFIX[i % PREFIX.length];
  const b = SUFFIX[Math.floor(i / PREFIX.length) % SUFFIX.length];
  const tier = Math.floor(i / (PREFIX.length * SUFFIX.length)) + 1;
  return tier > 1 ? `${a} ${b} ${tier}` : `${a} ${b}`;
}

export const SHIP_COUNT = 1000;
export const SHIPS: Ship[] = Array.from({ length: SHIP_COUNT }, (_, i) => {
  // Smooth scaling that stays tractable across 1000 tiers
  const price = i === 0 ? 0 : Math.round(60 * Math.pow(1.045, i));
  const hue = Math.floor((i * 37) % 360);
  return {
    id: i,
    name: shipName(i),
    price,
    fireRate: Math.min(18, 2 + i * 0.02),
    bulletDmg: 6 + i * 1.4,
    bulletSpeed: Math.min(1800, 600 + i * 2),
    bulletColor: `oklch(0.85 0.22 ${hue})`,
    hp: 100 + i * 25,                       // #1=100, #1000=25075
    maxSpeed: Math.min(900, 340 + i * 0.7),
    accel: Math.min(700, 260 + i * 0.6),
    shape: i % 5,
    size: Math.min(60, 30 + i * 0.04),
  };
});

export const DIAMOND_RATIO = 0.1;
export const diamondPrice = (s: Ship) => Math.max(1, Math.ceil(s.price * DIAMOND_RATIO));

// ───── 20 SHIELD TYPES — each adds different absorb HP to the bank ─────
export type ShieldType = {
  id: number;
  name: string;
  hp: number;            // damage absorbed per pack
  coinPrice: number;
  diamondPrice: number;
  color: string;
};

export const SHIELDS: ShieldType[] = Array.from({ length: 20 }, (_, i) => {
  const hp = 60 + i * 40;                                  // 60 → 820
  const coinPrice = Math.round(50 * Math.pow(1.18, i));    // ~50 → 1200
  const diamondPrice = Math.max(1, Math.ceil(coinPrice * 0.1));
  const tones = ["Basic","Reinforced","Plasma","Ion","Phase","Aegis","Bulwark","Mythril","Quantum","Hardlight",
                 "Spectral","Voidweave","Stellar","Nebula","Crystal","Photon","Tachyon","Singular","Eternal","Apex"];
  const hue = 180 + i * 8;
  return { id: i, name: `${tones[i]} Shield`, hp, coinPrice, diamondPrice, color: `oklch(0.82 0.18 ${hue})` };
});
export const SHIELD_MAX_STORE = 99999;
export const SHIELD_ACTIVE_CAP = 1000;

// ───── 20 ROCKETS — homing missiles, launched with E ─────
export type Rocket = {
  id: number;
  name: string;
  dmg: number;
  speed: number;
  turnRate: number;
  ttl: number;
  coinPrice: number;
  diamondPrice: number;
  color: string;
};

const ROCKET_NAMES = [
  "Mini Missile","Seeker","Hellfire","Nova","Annihilator",
  "Cyclone","Inferno","Eradicator","Singular","Voidlance",
  "Sunburst","Tempest","Wraith","Phoenix","Cataclysm",
  "Genesis","Apex","Stellar Lance","Omega","Reckoning",
];
export const ROCKETS: Rocket[] = ROCKET_NAMES.map((name, i) => ({
  id: i,
  name,
  dmg: Math.round(80 * Math.pow(1.22, i)),                  // 80 → ~3600
  speed: 700 + i * 35,
  turnRate: 2 + i * 0.12,
  ttl: 4 + i * 0.1,
  coinPrice: Math.round(20 * Math.pow(1.16, i)),
  diamondPrice: Math.max(1, Math.ceil(20 * Math.pow(1.16, i) * 0.1)),
  color: `oklch(0.80 0.24 ${(i * 23) % 360})`,
}));

export const COLOR_OPTIONS = [
  "oklch(0.78 0.18 30)",
  "oklch(0.82 0.18 60)",
  "oklch(0.88 0.18 95)",
  "oklch(0.78 0.20 140)",
  "oklch(0.78 0.18 195)",
  "oklch(0.70 0.20 250)",
  "oklch(0.70 0.22 300)",
  "oklch(0.78 0.20 340)",
  "oklch(0.92 0.02 240)",
  "oklch(0.55 0.10 240)",
];
