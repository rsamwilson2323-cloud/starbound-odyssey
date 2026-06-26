import { useEffect, useMemo, useRef, useState } from "react";
import { generateHazards, generateCoins, generateCoinBatch, hashSeed, GALAXY_SIZE, SAFE_RADIUS, randomSpawnInArena, COIN_TIERS, DIAMOND_TIERS, type CoinDrop } from "@/game/world";
import { createMultiplayer, type RemoteShip, type ShootEvt } from "@/game/multiplayer";
import { SHIPS, ROCKETS, SHIELDS, SHIELD_ACTIVE_CAP, SHIELD_MAX_STORE, diamondPrice, COLOR_OPTIONS, type Ship, type Rocket, type ShieldType } from "@/game/ships";
import { initAudio, Sounds } from "@/game/sounds";

const SAVE_PREFIX = "stellar_save_v5:";
const POSITION_PREFIX = "stellar_room_state_v2:";
const DEATH_PREFIX = "stellar_deaths_v1:";
const BAN_PREFIX = "stellar_banned_v1:";
const MOBILE_PREF_KEY = "stellar_mobile_controls";

type Save = {
  coins: number;
  diamonds: number;
  ownedShipIds: number[];
  currentShipId: number;
  color: string;
  shieldHp: number;             // stored damage-absorb bank
  rockets: Record<number, number>; // rocketId -> count
  activeRocketId: number;
  hasPlayed: boolean;
};

function defaultSave(): Save {
  return {
    coins: 200, diamonds: 5, ownedShipIds: [0], currentShipId: 0,
    color: COLOR_OPTIONS[4], shieldHp: 0,
    rockets: { 0: 3 }, activeRocketId: 0, hasPlayed: false,
  };
}
function loadSave(name: string): Save {
  if (typeof window === "undefined") return defaultSave();
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + name);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultSave(), ...parsed, rockets: { ...defaultSave().rockets, ...(parsed.rockets ?? {}) } };
    }
  } catch {}
  return defaultSave();
}
function saveSave(name: string, s: Save) {
  try { localStorage.setItem(SAVE_PREFIX + name, JSON.stringify(s)); } catch {}
}

function deathKey(pilotName: string, room: string) { return `${DEATH_PREFIX}${pilotName}:${room}`; }
function banKey(pilotName: string, room: string) { return `${BAN_PREFIX}${pilotName}:${room}`; }
function loadDeathCount(pilotName: string, room: string): number {
  try { return parseInt(localStorage.getItem(deathKey(pilotName, room)) ?? "0", 10) || 0; } catch { return 0; }
}
function saveDeathCount(pilotName: string, room: string, n: number) {
  try { localStorage.setItem(deathKey(pilotName, room), String(n)); } catch {}
}
function isBanned(pilotName: string, room: string): boolean {
  try { return localStorage.getItem(banKey(pilotName, room)) === "1"; } catch { return false; }
}
function banFromRoom(pilotName: string, room: string) {
  try { localStorage.setItem(banKey(pilotName, room), "1"); } catch {}
}

type PersistedRoomState = { vx: number; vy: number; angle: number };
function roomStateKey(roomCode: string, pilotId: string) { return `${POSITION_PREFIX}${roomCode}:${pilotId}`; }
function loadRoomState(roomCode: string, pilotId: string): PersistedRoomState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(roomStateKey(roomCode, pilotId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedRoomState;
    if ([p.vx, p.vy, p.angle].every((v) => Number.isFinite(v))) return p;
  } catch {}
  return null;
}
function saveRoomState(roomCode: string, pilotId: string, s: PersistedRoomState) {
  try { sessionStorage.setItem(roomStateKey(roomCode, pilotId), JSON.stringify(s)); } catch {}
}

type Bullet = {
  bid: string;
  shooter: string;
  x: number; y: number;
  vx: number; vy: number;
  dmg: number;
  color: string;
  ttl: number;
  ownedBySelf: boolean;
  isRocket?: boolean;
  targetId?: string;
  turnRate?: number;
  speed?: number;
};

type LootPile = { id: string; x: number; y: number; coins: number; diamonds: number };

const BOOST_MAX = 5;
const BOOST_COOLDOWN = 8;
const COIN_RESPAWN_SECONDS = 8;
const DEATHS_BEFORE_BAN = 5;

type SelfMutable = {
  hp: number;
  maxHp: number;
};

export default function GameCanvas({
  pilotId, pilotName, roomCode, onExit,
}: { pilotId: string; pilotName: string; roomCode: string; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [save, setSave] = useState<Save>(() => loadSave(pilotName));
  const [peerCount, setPeerCount] = useState(0);
  const [hp, setHp] = useState(0);
  const [maxHp, setMaxHp] = useState(0);
  const [shieldHpUi, setShieldHpUi] = useState(0);
  const [activeShieldUi, setActiveShieldUi] = useState(0);
  const [showMenu, setShowMenu] = useState(false);
  const [showHangar, setShowHangar] = useState(false);
  const [hangarTab, setHangarTab] = useState<"plane" | "rocket" | "shield">("plane");
  const [planePage, setPlanePage] = useState(0);
  const [selectedShield, setSelectedShield] = useState(0);
  const [showFullMap, setShowFullMap] = useState(false);
  const [dead, setDead] = useState(false);
  const [banned, setBanned] = useState(false);
  const [respawnIn, setRespawnIn] = useState(0);
  const [boostLeft, setBoostLeft] = useState(BOOST_MAX);
  const [boostCd, setBoostCd] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [playerPos, setPlayerPos] = useState({ x: 0, y: 0 });
  const [deathCount, setDeathCount] = useState(() => loadDeathCount(pilotName, roomCode));
  const [mobileControls, setMobileControls] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(MOBILE_PREF_KEY) === "1";
  });
  const keysRef = useRef<Set<string>>(new Set());
  const fireRocketRef = useRef<() => void>(() => {});
  const activateShieldRef = useRef<() => void>(() => {});

  useEffect(() => { saveSave(pilotName, save); }, [save, pilotName]);
  useEffect(() => { localStorage.setItem(MOBILE_PREF_KEY, mobileControls ? "1" : "0"); }, [mobileControls]);

  const currentShip = useMemo<Ship>(() => SHIPS[save.currentShipId] ?? SHIPS[0], [save.currentShipId]);
  const activeRocket = useMemo<Rocket>(() => ROCKETS[save.activeRocketId] ?? ROCKETS[0], [save.activeRocketId]);

  const saveRef = useRef(save); useEffect(() => { saveRef.current = save; }, [save]);
  const shipRef = useRef(currentShip); useEffect(() => { shipRef.current = currentShip; }, [currentShip]);
  const rocketRef = useRef(activeRocket); useEffect(() => { rocketRef.current = activeRocket; }, [activeRocket]);
  const selfMutRef = useRef<SelfMutable>({ hp: 0, maxHp: 0 });

  // When the user equips a different ship, carry the current HP% to the new ship.
  useEffect(() => {
    const m = selfMutRef.current;
    if (!m) return;
    const pct = m.maxHp > 0 ? Math.max(0.2, m.hp / m.maxHp) : 1;
    const deaths = loadDeathCount(pilotName, roomCode);
    const factor = Math.max(0.2, 1 - 0.2 * deaths);
    const newMax = Math.max(1, Math.round(currentShip.hp * factor));
    m.maxHp = newMax;
    m.hp = Math.max(1, Math.round(newMax * pct));
    setMaxHp(newMax); setHp(m.hp);
  }, [currentShip, pilotName, roomCode]);

  const seed = useMemo(() => hashSeed(roomCode), [roomCode]);
  const hazards = useMemo(() => generateHazards(seed), [seed]);

  useEffect(() => {
    if (isBanned(pilotName, roomCode)) {
      setBanned(true);
      setTimeout(() => onExit(), 2200);
    }
  }, [pilotName, roomCode, onExit]);

  useEffect(() => {
    if (banned) return;
    initAudio();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const coins = new Map<string, CoinDrop>();
    for (const c of generateCoins(seed)) coins.set(c.id, c);
    const knownBuckets = new Set<number>();
    const loot = new Map<string, LootPile>();
    const bullets: Bullet[] = [];
    const peers = new Map<string, RemoteShip>();
    const keys = keysRef.current;
    keys.clear();

    let deaths = loadDeathCount(pilotName, roomCode);
    const restored = loadRoomState(roomCode, pilotId);
    const baseMax = Math.max(1, Math.round(shipRef.current.hp * (1 - 0.2 * deaths)));
    const spawn = randomSpawnInArena();
    const self = {
      id: pilotId,
      x: spawn.x, y: spawn.y,
      vx: restored?.vx ?? 0, vy: restored?.vy ?? 0,
      angle: restored?.angle ?? -Math.PI / 2,
      thrust: false,
      hp: baseMax,
      maxHp: baseMax,
      shield: 0,
      alive: true,
      lastShot: 0,
      lastRocket: 0,
      lastShieldKey: 0,
      boostBudget: BOOST_MAX,
      boostActive: false,
      boostCdUntil: 0,
      lastCrashAt: 0,
      coinsThisLife: 0,
      diamondsThisLife: 0,
      respawnAt: 0,
      isFirstDeath: !saveRef.current.hasPlayed,
    };
    selfMutRef.current = { hp: self.hp, maxHp: self.maxHp };
    setHp(self.hp); setMaxHp(self.maxHp); setShieldHpUi(saveRef.current.shieldHp); setActiveShieldUi(0);

    const bgStars = Array.from({ length: 600 }, () => ({
      x: Math.random() * 3000 - 1500, y: Math.random() * 3000 - 1500,
      z: 0.2 + Math.random() * 0.7, s: Math.random() * 1.8 + 0.4,
    }));

    function resize() {
      canvas.width = window.innerWidth * window.devicePixelRatio;
      canvas.height = window.innerHeight * window.devicePixelRatio;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
    }
    resize();
    window.addEventListener("resize", resize);

    const mp = createMultiplayer(roomCode, {
      id: pilotId, name: pilotName, color: saveRef.current.color, shipId: shipRef.current.id,
      x: self.x, y: self.y, angle: self.angle, thrust: false,
      hp: self.hp, maxHp: self.maxHp, alive: true,
    }, {
      onPeers: (p) => { peers.clear(); for (const [k, v] of p) peers.set(k, v); setPeerCount(peers.size); },
      onShoot: (e: ShootEvt) => { bullets.push({ ...e, ownedBySelf: false }); },
      onHit: (e) => {
        if (e.target !== pilotId || !self.alive) return;
        applyDamage(e.dmg);
        if (self.hp <= 0) doDeath(e.shooter);
      },
      onDeath: (e) => {
        loot.set(e.victim + ":" + e.x.toFixed(0), {
          id: e.victim + ":" + e.x.toFixed(0), x: e.x, y: e.y, coins: e.coins, diamonds: e.diamonds,
        });
      },
      onCoinClaim: (id) => { coins.delete(id); },
      onLootClaim: (id) => { loot.delete(id); },
    });

    function applyDamage(d: number) {
      let rem = d;
      if (self.shield > 0) {
        const absorb = Math.min(self.shield, rem);
        self.shield -= absorb; rem -= absorb;
        setActiveShieldUi(self.shield);
      }
      if (rem > 0) { self.hp -= rem; selfMutRef.current.hp = self.hp; setHp(Math.max(0, self.hp)); }
      Sounds.hit();
    }

    function doDeath(killer: string | null) {
      if (!self.alive) return;
      self.alive = false;
      Sounds.death();
      const dropCoins = self.coinsThisLife;
      const dropDiamonds = self.diamondsThisLife;
      if (dropCoins > 0 || dropDiamonds > 0) {
        const id = pilotId + ":" + Math.floor(self.x);
        loot.set(id, { id, x: self.x, y: self.y, coins: dropCoins, diamonds: dropDiamonds });
        mp.sendDeath({ victim: pilotId, killer, x: self.x, y: self.y, coins: dropCoins, diamonds: dropDiamonds });
      }
      self.coinsThisLife = 0; self.diamondsThisLife = 0;

      deaths += 1;
      saveDeathCount(pilotName, roomCode, deaths);
      setDeathCount(deaths);

      if (deaths >= DEATHS_BEFORE_BAN) {
        banFromRoom(pilotName, roomCode);
        setBanned(true);
        setDead(true);
        setSave((s) => ({ ...s, hasPlayed: true }));
        setTimeout(() => onExit(), 4000);
        return;
      }

      const wait = self.isFirstDeath ? 5 : 8;
      self.isFirstDeath = false;
      self.respawnAt = performance.now() + wait * 1000;
      setDead(true);
      setRespawnIn(wait);
      setSave((s) => ({ ...s, hasPlayed: true }));
    }

    function respawn() {
      const sp = randomSpawnInArena();
      self.x = sp.x; self.y = sp.y;
      self.vx = self.vy = 0;
      const factor = Math.max(0, 1 - 0.2 * deaths);
      self.maxHp = Math.max(1, Math.round(shipRef.current.hp * factor));
      self.hp = self.maxHp;
      self.shield = 0;
      self.alive = true;
      self.boostBudget = BOOST_MAX;
      self.boostCdUntil = 0;
      selfMutRef.current.hp = self.hp; selfMutRef.current.maxHp = self.maxHp;
      setHp(self.hp); setMaxHp(self.maxHp); setActiveShieldUi(0);
      setDead(false);
      Sounds.respawn();
    }

    function tryActivateShield(now: number) {
      if (now - self.lastShieldKey < 250) return;
      self.lastShieldKey = now;
      const stored = saveRef.current.shieldHp;
      if (stored <= 0) { flashLocal("No shields stored — buy in Hangar (B)"); return; }
      const need = Math.max(0, SHIELD_ACTIVE_CAP - self.shield);
      if (need <= 0) { flashLocal("Shield full"); return; }
      const take = Math.min(stored, need);
      self.shield += take;
      setActiveShieldUi(self.shield);
      setSave((s) => ({ ...s, shieldHp: Math.max(0, s.shieldHp - take) }));
      Sounds.shieldOn();
    }

    function flashLocal(msg: string) { setNotice(msg); setTimeout(() => setNotice(null), 1600); }

    function fireRocket(now: number) {
      if (now - self.lastRocket < 350) return;
      const rocket = rocketRef.current;
      const inv = saveRef.current.rockets[rocket.id] ?? 0;
      if (inv <= 0) { flashLocal(`No ${rocket.name} — buy in Hangar (B)`); return; }
      let best: RemoteShip | null = null;
      let bestD = 2400;
      for (const p of peers.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - self.x, p.y - self.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best) { flashLocal("No target in range"); return; }
      self.lastRocket = now;
      const bid = `rkt-${pilotId}-${now.toFixed(0)}-${Math.floor(Math.random()*999)}`;
      const bx = self.x + Math.cos(self.angle) * (shipRef.current.size * 0.9);
      const by = self.y + Math.sin(self.angle) * (shipRef.current.size * 0.9);
      const vx = Math.cos(self.angle) * rocket.speed;
      const vy = Math.sin(self.angle) * rocket.speed;
      bullets.push({
        bid, shooter: pilotId, x: bx, y: by, vx, vy,
        dmg: rocket.dmg, color: rocket.color, ttl: rocket.ttl,
        ownedBySelf: true,
        isRocket: true, targetId: best.id, turnRate: rocket.turnRate, speed: rocket.speed,
      });
      mp.sendShoot({ shooter: pilotId, bid, x: bx, y: by, vx, vy, dmg: rocket.dmg, color: rocket.color, ttl: rocket.ttl });
      setSave((s) => ({ ...s, rockets: { ...s.rockets, [rocket.id]: Math.max(0, (s.rockets[rocket.id] ?? 0) - 1) } }));
      Sounds.rocket();
    }

    fireRocketRef.current = () => { if (self.alive) fireRocket(performance.now()); };
    activateShieldRef.current = () => { if (self.alive) tryActivateShield(performance.now()); };



    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keys.add(k);
      if (e.key === "Escape") setShowMenu((m) => !m);
      if (k === "b") { setShowHangar((v) => !v); Sounds.click(); }
      if (k === "m") { setShowFullMap((v) => !v); Sounds.click(); }
      if (k === "f" && self.alive) tryActivateShield(performance.now());
      if (k === "e" && self.alive) fireRocket(performance.now());
      if (k >= "1" && k <= "9") {
        const idx = parseInt(k, 10) - 1;
        if (idx < ROCKETS.length) setSave((s) => ({ ...s, activeRocketId: idx }));
      }
      if (e.code === "Space" || e.key === "Backspace" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "Backspace" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
      }
      keys.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let last = performance.now(), raf = 0;
    const startTime = last;

    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Sync HP from external ship swap effect
      if (selfMutRef.current.maxHp !== self.maxHp) {
        self.maxHp = selfMutRef.current.maxHp;
        self.hp = selfMutRef.current.hp;
      }

      const bucket = Math.floor((now - startTime) / (COIN_RESPAWN_SECONDS * 1000));
      if (!knownBuckets.has(bucket)) {
        knownBuckets.add(bucket);
        if (bucket > 0) {
          for (const c of generateCoinBatch(seed, bucket, 120)) {
            if (!coins.has(c.id)) coins.set(c.id, c);
          }
        }
      }

      const ship = shipRef.current;
      if (self.alive) {
        const wantBoost = keys.has("q");
        const cdActive = now < self.boostCdUntil;
        if (wantBoost && self.boostBudget > 0 && !cdActive) {
          if (!self.boostActive) { self.boostActive = true; Sounds.boost(); }
          self.boostBudget = Math.max(0, self.boostBudget - dt);
          if (self.boostBudget <= 0) { self.boostActive = false; self.boostCdUntil = now + BOOST_COOLDOWN * 1000; }
        } else {
          if (self.boostActive) { self.boostActive = false; self.boostCdUntil = now + BOOST_COOLDOWN * 1000; }
          self.boostBudget = Math.min(BOOST_MAX, self.boostBudget + (BOOST_MAX / BOOST_COOLDOWN) * dt);
        }
        setBoostLeft(self.boostBudget);
        setBoostCd(Math.max(0, (self.boostCdUntil - now) / 1000));

        const turnRate = 3.2;
        const boostMul = self.boostActive ? 2.4 : 1;
        const accel = ship.accel * boostMul;
        const maxSpd = ship.maxSpeed * boostMul;
        if (keys.has("arrowleft") || keys.has("a")) self.angle -= turnRate * dt;
        if (keys.has("arrowright") || keys.has("d")) self.angle += turnRate * dt;
        const forward = keys.has("arrowup") || keys.has("w");
        const reverse = keys.has("arrowdown") || keys.has("s");
        const braking = keys.has("backspace");
        self.thrust = forward;
        if (forward)  { self.vx += Math.cos(self.angle) * accel * dt; self.vy += Math.sin(self.angle) * accel * dt; }
        if (reverse)  { self.vx -= Math.cos(self.angle) * accel * 0.72 * dt; self.vy -= Math.sin(self.angle) * accel * 0.72 * dt; }
        if (braking)  { self.vx *= 1 - 4.2 * dt; self.vy *= 1 - 4.2 * dt; }
        self.vx *= 1 - 0.05 * dt; self.vy *= 1 - 0.05 * dt;
        const sp = Math.hypot(self.vx, self.vy);
        if (sp > maxSpd) { self.vx = self.vx / sp * maxSpd; self.vy = self.vy / sp * maxSpd; }
        self.x += self.vx * dt; self.y += self.vy * dt;
        const limit = SAFE_RADIUS - ship.size * 0.7;
        const distFromCenter = Math.hypot(self.x, self.y);
        if (distFromCenter > limit) {
          const nx = self.x / (distFromCenter || 1);
          const ny = self.y / (distFromCenter || 1);
          self.x = nx * limit; self.y = ny * limit;
          const outwardSpeed = self.vx * nx + self.vy * ny;
          if (outwardSpeed > 0) { self.vx -= nx * outwardSpeed * 1.6; self.vy -= ny * outwardSpeed * 1.6; }
          self.vx *= 0.94; self.vy *= 0.94;
        }

        if (keys.has(" ") || keys.has("space")) {
          const interval = 1 / ship.fireRate;
          if (now - self.lastShot > interval * 1000) {
            self.lastShot = now;
            const bid = `${pilotId}-${now.toFixed(0)}-${Math.floor(Math.random() * 999)}`;
            const bx = self.x + Math.cos(self.angle) * (ship.size * 0.8);
            const by = self.y + Math.sin(self.angle) * (ship.size * 0.8);
            const bvx = self.vx + Math.cos(self.angle) * ship.bulletSpeed;
            const bvy = self.vy + Math.sin(self.angle) * ship.bulletSpeed;
            const b: Bullet = { bid, shooter: pilotId, x: bx, y: by, vx: bvx, vy: bvy, dmg: ship.bulletDmg, color: ship.bulletColor, ttl: 1.8, ownedBySelf: true };
            bullets.push(b);
            mp.sendShoot({ shooter: pilotId, bid, x: bx, y: by, vx: bvx, vy: bvy, dmg: ship.bulletDmg, color: ship.bulletColor, ttl: 1.8 });
            Sounds.shoot();
          }
        }

        for (const hz of hazards) {
          const d = Math.hypot(hz.x - self.x, hz.y - self.y);
          if (d < hz.radius + ship.size * 0.5) {
            if (hz.kind === "blackhole") { doDeath(null); break; }
            if (hz.kind === "star") { doDeath(null); break; }
            if (now - self.lastCrashAt > 700) {
              self.lastCrashAt = now;
              const dmg = Math.max(8, Math.min(400, Math.round(hz.radius * 0.55)));
              applyDamage(dmg);
              const nx = (self.x - hz.x) / (d || 1);
              const ny = (self.y - hz.y) / (d || 1);
              self.x = hz.x + nx * (hz.radius + ship.size * 0.5 + 2);
              self.y = hz.y + ny * (hz.radius + ship.size * 0.5 + 2);
              self.vx = nx * 220; self.vy = ny * 220;
              if (self.hp <= 0) { doDeath(null); break; }
            }
          }
        }

        for (const c of coins.values()) {
          const d = Math.hypot(c.x - self.x, c.y - self.y);
          if (d < ship.size + 12) {
            if (c.kind === "diamond") {
              self.diamondsThisLife += c.value; Sounds.pickupDiamond();
              setSave((s) => ({ ...s, diamonds: s.diamonds + c.value }));
            } else {
              self.coinsThisLife += c.value; Sounds.pickupCoin();
              setSave((s) => ({ ...s, coins: s.coins + c.value }));
            }
            coins.delete(c.id);
            mp.sendCoinClaim(c.id);
          }
        }
        for (const lp of loot.values()) {
          const d = Math.hypot(lp.x - self.x, lp.y - self.y);
          if (d < ship.size + 20) {
            if (lp.coins) { self.coinsThisLife += lp.coins; setSave((s) => ({ ...s, coins: s.coins + lp.coins })); }
            if (lp.diamonds) { self.diamondsThisLife += lp.diamonds; setSave((s) => ({ ...s, diamonds: s.diamonds + lp.diamonds })); }
            Sounds.pickupCoin();
            loot.delete(lp.id);
            mp.sendLootClaim(lp.id);
          }
        }
      } else if (!banned) {
        const remain = Math.max(0, (self.respawnAt - now) / 1000);
        setRespawnIn(Math.ceil(remain));
        if (remain <= 0) respawn();
      }

      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        if (b.ownedBySelf && b.isRocket && b.targetId && b.turnRate && b.speed) {
          const target = peers.get(b.targetId);
          if (target && target.alive) {
            const desiredAng = Math.atan2(target.y - b.y, target.x - b.x);
            const curAng = Math.atan2(b.vy, b.vx);
            let diff = desiredAng - curAng;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            const turn = Math.max(-b.turnRate * dt, Math.min(b.turnRate * dt, diff));
            const newAng = curAng + turn;
            b.vx = Math.cos(newAng) * b.speed;
            b.vy = Math.sin(newAng) * b.speed;
          }
        }
        b.x += b.vx * dt; b.y += b.vy * dt; b.ttl -= dt;
        if (b.ttl <= 0) { bullets.splice(i, 1); continue; }
        if (self.alive && b.shooter !== pilotId) {
          const d = Math.hypot(b.x - self.x, b.y - self.y);
          if (d < shipRef.current.size * 0.7) {
            applyDamage(b.dmg);
            bullets.splice(i, 1);
            if (self.hp <= 0) doDeath(b.shooter);
            continue;
          }
        }
        if (b.ownedBySelf) {
          for (const p of peers.values()) {
            if (!p.alive) continue;
            const psize = (SHIPS[p.shipId]?.size ?? 30) * 0.7;
            const d = Math.hypot(b.x - p.x, b.y - p.y);
            if (d < psize) {
              mp.sendHit({ target: p.id, shooter: pilotId, dmg: b.dmg });
              bullets.splice(i, 1);
              break;
            }
          }
        }
      }

      mp.sendShip({
        id: pilotId, name: pilotName, color: saveRef.current.color, shipId: shipRef.current.id,
        x: self.x, y: self.y, angle: self.angle, thrust: self.thrust,
        hp: self.hp, maxHp: self.maxHp, alive: self.alive,
      });
      mp.pruneStale();

      // ===== render =====
      const W = canvas.width, Hc = canvas.height;
      const dpr = window.devicePixelRatio;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bg = ctx.createRadialGradient(W * 0.3, Hc * 0.25, 0, W * 0.5, Hc * 0.5, Math.max(W, Hc));
      bg.addColorStop(0, "#0a0a22"); bg.addColorStop(0.5, "#04050f"); bg.addColorStop(1, "#01010a");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, Hc);

      ctx.save();
      ctx.translate(W / 2, Hc / 2);
      for (const bs of bgStars) {
        const px = ((bs.x - self.x * bs.z * 0.05) % 3000 + 4500) % 3000 - 1500;
        const py = ((bs.y - self.y * bs.z * 0.05) % 3000 + 4500) % 3000 - 1500;
        ctx.globalAlpha = bs.z; ctx.fillStyle = "#cfd8ff";
        ctx.fillRect(px * dpr, py * dpr, bs.s, bs.s);
      }
      ctx.globalAlpha = 1; ctx.restore();

      saveRoomState(roomCode, pilotId, { vx: self.vx, vy: self.vy, angle: self.angle });
      if ((now | 0) % 120 < 20) {
        setPlayerPos((prev) => (
          Math.abs(prev.x - self.x) > 64 || Math.abs(prev.y - self.y) > 64 ? { x: self.x, y: self.y } : prev
        ));
      }

      const zoom = 0.7;
      ctx.save();
      ctx.translate(W / 2, Hc / 2);
      ctx.scale(zoom * dpr, zoom * dpr);
      ctx.translate(-self.x, -self.y);

      ctx.strokeStyle = "rgba(120, 220, 255, 0.35)"; ctx.lineWidth = 10 / zoom;
      ctx.beginPath(); ctx.arc(0, 0, SAFE_RADIUS, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(120, 220, 255, 0.12)"; ctx.lineWidth = 40 / zoom;
      ctx.beginPath(); ctx.arc(0, 0, SAFE_RADIUS, 0, Math.PI * 2); ctx.stroke();

      const viewR = 1700 / zoom;
      for (const hz of hazards) {
        if (Math.abs(hz.x - self.x) > viewR || Math.abs(hz.y - self.y) > viewR) continue;
        if (hz.kind === "blackhole") {
          const grad = ctx.createRadialGradient(hz.x, hz.y, hz.radius * 0.3, hz.x, hz.y, hz.radius * 3);
          grad.addColorStop(0, "#000"); grad.addColorStop(0.5, "rgba(80,20,120,0.5)"); grad.addColorStop(1, "transparent");
          ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius * 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(180,100,255,0.6)"; ctx.lineWidth = 2 / zoom;
          ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius * 1.4, 0, Math.PI * 2); ctx.stroke();
        } else if (hz.kind === "star") {
          const glow = ctx.createRadialGradient(hz.x, hz.y, hz.radius * 0.4, hz.x, hz.y, hz.radius * 3);
          glow.addColorStop(0, hz.color); glow.addColorStop(0.3, "rgba(255,200,80,0.4)"); glow.addColorStop(1, "transparent");
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius * 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = hz.color; ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.fill();
        } else if (hz.kind === "planet") {
          const grad = ctx.createRadialGradient(hz.x - hz.radius * 0.3, hz.y - hz.radius * 0.3, hz.radius * 0.1, hz.x, hz.y, hz.radius);
          grad.addColorStop(0, hz.color); grad.addColorStop(1, "rgba(0,0,0,0.85)");
          ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.fill();
          if ((hz.x | 0) % 3 === 0) {
            ctx.strokeStyle = "rgba(200,180,140,0.4)"; ctx.lineWidth = 3 / zoom;
            ctx.beginPath(); ctx.ellipse(hz.x, hz.y, hz.radius * 1.6, hz.radius * 0.45, 0.4, 0, Math.PI * 2); ctx.stroke();
          }
        } else {
          const grad = ctx.createRadialGradient(hz.x - hz.radius * 0.4, hz.y - hz.radius * 0.4, 1, hz.x, hz.y, hz.radius);
          grad.addColorStop(0, "oklch(0.55 0.04 50)"); grad.addColorStop(1, hz.color);
          ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(hz.x, hz.y, hz.radius, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1.5 / zoom; ctx.stroke();
        }
      }

      for (const c of coins.values()) {
        if (Math.abs(c.x - self.x) > viewR || Math.abs(c.y - self.y) > viewR) continue;
        if (c.kind === "diamond") {
          ctx.fillStyle = c.color;
          ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(now * 0.003);
          const sz = c.tier === "purple" ? 13 : 10;
          ctx.beginPath();
          ctx.moveTo(0, -sz); ctx.lineTo(sz * 0.8, 0); ctx.lineTo(0, sz); ctx.lineTo(-sz * 0.8, 0); ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.4 / zoom; ctx.stroke();
          ctx.restore();
        } else {
          const sz = c.tier === "red" ? 10 : c.tier === "pink" ? 8.5 : c.tier === "green" ? 7.2 : 6;
          ctx.fillStyle = c.color;
          ctx.beginPath(); ctx.arc(c.x, c.y, sz, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.2 / zoom; ctx.stroke();
        }
      }

      for (const lp of loot.values()) {
        if (Math.abs(lp.x - self.x) > viewR || Math.abs(lp.y - self.y) > viewR) continue;
        ctx.fillStyle = "rgba(255,200,80,0.3)";
        ctx.beginPath(); ctx.arc(lp.x, lp.y, 26 + Math.sin(now * 0.005) * 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "oklch(0.9 0.2 90)";
        ctx.beginPath(); ctx.arc(lp.x, lp.y, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = `${12 / zoom}px Orbitron, sans-serif`; ctx.textAlign = "center";
        ctx.fillText(`${lp.coins}c${lp.diamonds ? " " + lp.diamonds + "♦" : ""}`, lp.x, lp.y - 20);
        ctx.textAlign = "start";
      }

      for (const b of bullets) {
        ctx.fillStyle = b.color;
        const r = b.isRocket ? 6 : 4;
        ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = b.color; ctx.lineWidth = (b.isRocket ? 3.5 : 2.4) / zoom; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(b.x, b.y);
        const tf = b.isRocket ? 0.06 : 0.04;
        ctx.lineTo(b.x - b.vx * tf, b.y - b.vy * tf); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (const p of peers.values()) {
        if (Math.abs(p.x - self.x) > viewR || Math.abs(p.y - self.y) > viewR) continue;
        if (!p.alive) continue;
        const ps = SHIPS[p.shipId] ?? SHIPS[0];
        drawShip(ctx, p.x, p.y, p.angle, p.color, p.thrust, ps, zoom);
        ctx.fillStyle = "rgba(220,230,255,0.9)"; ctx.font = `${12 / zoom}px Orbitron, sans-serif`;
        ctx.textAlign = "center"; ctx.fillText(p.name, p.x, p.y - ps.size - 8);
        const hpw = ps.size * 1.6, hph = 4;
        ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(p.x - hpw / 2, p.y - ps.size - 4, hpw, hph);
        ctx.fillStyle = "oklch(0.7 0.22 20)";
        ctx.fillRect(p.x - hpw / 2, p.y - ps.size - 4, hpw * Math.max(0, p.hp / p.maxHp), hph);
        ctx.textAlign = "start";
      }

      if (self.alive) {
        drawShip(ctx, self.x, self.y, self.angle, saveRef.current.color, self.thrust, shipRef.current, zoom, true);
        if (self.shield > 0) {
          ctx.strokeStyle = "rgba(120,200,255,0.85)"; ctx.lineWidth = 3 / zoom;
          ctx.beginPath(); ctx.arc(self.x, self.y, shipRef.current.size + 8 + Math.sin(now * 0.01) * 2, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = "rgba(120,200,255,0.25)"; ctx.lineWidth = 12 / zoom;
          ctx.beginPath(); ctx.arc(self.x, self.y, shipRef.current.size + 10, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      mp.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pilotId, pilotName, roomCode, seed, banned]);

  function buyShip(s: Ship, useDiamond: boolean) {
    if (save.ownedShipIds.includes(s.id)) return;
    // Sequential buying — must own the previous ship first
    if (s.id > 0 && !save.ownedShipIds.includes(s.id - 1)) {
      flash(`Buy #${s.id} first to unlock #${s.id + 1}`);
      return;
    }
    if (useDiamond) {
      const cost = diamondPrice(s);
      if (save.diamonds < cost) { flash("Not enough diamonds"); return; }
      setSave((p) => ({ ...p, diamonds: p.diamonds - cost, ownedShipIds: [...p.ownedShipIds, s.id], currentShipId: s.id }));
    } else {
      if (save.coins < s.price) { flash("Not enough coins"); return; }
      setSave((p) => ({ ...p, coins: p.coins - s.price, ownedShipIds: [...p.ownedShipIds, s.id], currentShipId: s.id }));
    }
    // Buying a new plane resets your elimination count in this room — fresh start.
    saveDeathCount(pilotName, roomCode, 0);
    setDeathCount(0);
    Sounds.buy();
    flash(`Boarded #${s.id + 1} ${s.name} — eliminations reset, HP% carried over`);
  }
  function equipShip(s: Ship) {
    if (!save.ownedShipIds.includes(s.id)) return;
    setSave((p) => ({ ...p, currentShipId: s.id }));
    Sounds.click();
  }
  function pickColor(c: string) {
    if (c === save.color) return;
    if (save.coins < 1) { flash("Need 1 coin to change color"); return; }
    setSave((p) => ({ ...p, coins: p.coins - 1, color: c }));
    Sounds.click();
  }
  function buyShield(sh: ShieldType, useDiamond: boolean, qty = 1) {
    const totalCoin = sh.coinPrice * qty;
    const totalDia = sh.diamondPrice * qty;
    if (useDiamond) {
      if (save.diamonds < totalDia) { flash("Not enough diamonds"); return; }
      setSave((p) => ({ ...p, diamonds: p.diamonds - totalDia, shieldHp: Math.min(SHIELD_MAX_STORE, p.shieldHp + sh.hp * qty) }));
    } else {
      if (save.coins < totalCoin) { flash("Not enough coins"); return; }
      setSave((p) => ({ ...p, coins: p.coins - totalCoin, shieldHp: Math.min(SHIELD_MAX_STORE, p.shieldHp + sh.hp * qty) }));
    }
    Sounds.buy();
    flash(`+${sh.hp * qty} shield stored — press F to activate`);
  }
  function buyRocket(r: Rocket, useDiamond: boolean, qty = 1) {
    const cc = r.coinPrice * qty;
    const dd = r.diamondPrice * qty;
    if (useDiamond) {
      if (save.diamonds < dd) { flash("Not enough diamonds"); return; }
      setSave((p) => ({ ...p, diamonds: p.diamonds - dd, rockets: { ...p.rockets, [r.id]: (p.rockets[r.id] ?? 0) + qty } }));
    } else {
      if (save.coins < cc) { flash("Not enough coins"); return; }
      setSave((p) => ({ ...p, coins: p.coins - cc, rockets: { ...p.rockets, [r.id]: (p.rockets[r.id] ?? 0) + qty } }));
    }
    Sounds.buy();
  }
  function flash(msg: string) { setNotice(msg); setTimeout(() => setNotice(null), 1800); }

  const livesRemaining = Math.max(0, DEATHS_BEFORE_BAN - deathCount);
  const hpFactor = Math.max(0, 1 - 0.2 * deathCount);

  // Pagination for plane list (50 per page from 1000)
  const PLANES_PER_PAGE = 50;
  const totalPages = Math.ceil(SHIPS.length / PLANES_PER_PAGE);
  const planeSlice = SHIPS.slice(planePage * PLANES_PER_PAGE, (planePage + 1) * PLANES_PER_PAGE);

  return (
    <div className="relative w-full h-screen overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 block" />

      {/* Top HUD */}
      <div className="absolute top-3 left-3 right-3 flex justify-between gap-2 pointer-events-none">
        <div className="hud-panel px-3 py-2 pointer-events-auto">
          <div className="text-[9px] uppercase tracking-[0.2em] opacity-60">Pilot</div>
          <div className="font-[Orbitron] glow-text" style={{ color: save.color }}>{pilotName}</div>
          <div className="text-[10px] opacity-60">Room <b className="text-[color:var(--color-primary)]">{roomCode}</b> · {peerCount + 1} online</div>
          <div className="text-[10px] opacity-80 mt-1">Lives: <b className={livesRemaining <= 1 ? "text-red-300" : "text-emerald-300"}>{livesRemaining}/{DEATHS_BEFORE_BAN}</b> · Max HP {Math.round(hpFactor*100)}%</div>
        </div>
        <div className="hud-panel px-3 py-2 pointer-events-auto text-center">
          <div className="text-[9px] uppercase tracking-[0.2em] opacity-60">{currentShip.name} · #{currentShip.id + 1}</div>
          <div className="flex items-center gap-2">
            <div className="w-44 h-2 bg-black/60 rounded overflow-hidden">
              <div className="h-full" style={{ width: `${maxHp ? (hp / maxHp) * 100 : 0}%`, background: "oklch(0.75 0.22 20)" }} />
            </div>
            <div className="text-xs font-mono">{Math.max(0, Math.round(hp))}/{Math.round(maxHp)}</div>
          </div>
          {activeShieldUi > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-44 h-1.5 bg-black/60 rounded overflow-hidden">
                <div className="h-full" style={{ width: `${(activeShieldUi / SHIELD_ACTIVE_CAP) * 100}%`, background: "oklch(0.78 0.18 200)" }} />
              </div>
              <div className="text-[10px] font-mono text-cyan-300">{Math.round(activeShieldUi)}🛡 active</div>
            </div>
          )}
          <div className="text-[9px] opacity-70 mt-1">F shield ({shieldHpUi}) · E rocket · B shop · M map</div>
        </div>
        <div className="hud-panel px-3 py-2 pointer-events-auto text-right">
          <div className="text-[10px]"><span className="opacity-60">Coins</span> <b className="text-[color:var(--color-accent)]">{save.coins}</b></div>
          <div className="text-[10px]"><span className="opacity-60">Diamonds</span> <b className="text-cyan-300">{save.diamonds}</b></div>
          <div className="text-[10px] mt-1"><span className="opacity-60">Rocket</span> <b style={{ color: activeRocket.color }}>{activeRocket.name}</b> ×{save.rockets[activeRocket.id] ?? 0}</div>
          <div className="text-[9px] opacity-60">1-9 to switch</div>
        </div>
      </div>

      {/* Left-side legend: coin & diamond values */}
      <div className="absolute top-28 left-3 hud-panel px-3 py-2 pointer-events-auto text-[11px] w-[152px]">
        <div className="text-[9px] uppercase tracking-[0.2em] opacity-60 mb-1">Pickups</div>
        <div className="opacity-70 text-[9px] mt-1 mb-0.5">Coins</div>
        {COIN_TIERS.map((t) => (
          <div key={t.tier} className="flex items-center gap-2 leading-5">
            <span className="inline-block w-3 h-3 rounded-full border border-white/40" style={{ background: t.color }} />
            <span className="capitalize flex-1">{t.tier}</span>
            <b className="font-mono">{t.value}</b>
          </div>
        ))}
        <div className="opacity-70 text-[9px] mt-1.5 mb-0.5">Diamonds</div>
        {DIAMOND_TIERS.map((t) => (
          <div key={t.tier} className="flex items-center gap-2 leading-5">
            <span className="inline-block w-3 h-3 rotate-45 border border-white/40" style={{ background: t.color }} />
            <span className="capitalize flex-1">{t.tier}</span>
            <b className="font-mono">{t.value}</b>
          </div>
        ))}
      </div>

      {/* Sector minimap — click to expand */}
      <div
        className="absolute top-28 right-3 hud-panel px-3 py-3 w-[172px] cursor-pointer hover:ring-1 hover:ring-cyan-300/40 transition pointer-events-auto"
        onClick={() => { setShowFullMap(true); Sounds.click(); }}
        title="Click to expand map (M)"
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="text-[9px] uppercase tracking-[0.2em] opacity-60">Sector Map</div>
          <div className="text-[10px] opacity-60">⤢</div>
        </div>
        <svg width="146" height="146" viewBox="0 0 146 146" className="block mx-auto overflow-visible">
          <circle cx="73" cy="73" r="67" fill="rgba(0,0,0,0.35)" stroke="rgba(140,220,255,0.28)" strokeWidth="1" />
          <circle cx="73" cy="73" r="64" fill="none" stroke="rgba(120,220,255,0.55)" strokeWidth="2" />
          {hazards.filter((hz) => hz.kind !== "asteroid").slice(0, 200).map((hz) => {
            const x = 73 + (hz.x / SAFE_RADIUS) * 64;
            const y = 73 + (hz.y / SAFE_RADIUS) * 64;
            if (Math.hypot(x - 73, y - 73) > 67) return null;
            const r = hz.kind === "star" ? 2.4 : hz.kind === "blackhole" ? 2 : 1.4;
            const fill = hz.kind === "blackhole" ? "#8b5cf6" : hz.kind === "star" ? "#facc15" : "rgba(180,220,255,0.65)";
            return <circle key={hz.id} cx={x} cy={y} r={r} fill={fill} opacity={0.9} />;
          })}
          <circle cx={73 + (playerPos.x / SAFE_RADIUS) * 64} cy={73 + (playerPos.y / SAFE_RADIUS) * 64} r="3.5" fill={save.color} stroke="white" strokeWidth="1" />
        </svg>
      </div>

      {/* Boost / Controls */}
      <div className="absolute bottom-3 left-3 hud-panel px-3 py-2 pointer-events-none">
        <div className="text-[10px] uppercase tracking-widest opacity-60 mb-1">Boost {boostCd > 0 ? `· CD ${boostCd.toFixed(1)}s` : ""}</div>
        <div className="w-44 h-2 bg-black/60 rounded overflow-hidden">
          <div className="h-full transition-[width]" style={{ width: `${(boostLeft / BOOST_MAX) * 100}%`, background: boostCd > 0 ? "oklch(0.6 0.1 30)" : "oklch(0.85 0.2 90)" }} />
        </div>
        <div className="text-[11px] font-mono leading-5 mt-2">
          <div><b>W/↑</b> thrust · <b>S/↓</b> reverse · <b>A D ←→</b> turn · <b>Space</b> shoot</div>
          <div><b>Q</b> boost · <b>F</b> shield · <b>E</b> rocket · <b>B</b> shop · <b>M</b> map · <b>Esc</b> menu</div>
        </div>
      </div>

      <div className="absolute bottom-3 right-3 flex gap-2 pointer-events-auto">
        <button className="btn-cyber" onClick={() => { setShowFullMap(true); Sounds.click(); }}>Map (M)</button>
        <button className="btn-cyber" onClick={() => { setShowHangar(true); Sounds.click(); }}>Shop (B)</button>
        <button className="btn-cyber" onClick={() => { setShowMenu(true); Sounds.click(); }}>Menu</button>
      </div>

      {notice && (
        <div className="absolute left-1/2 top-20 -translate-x-1/2 hud-panel px-4 py-2 text-sm">{notice}</div>
      )}

      {/* Full map overlay */}
      {showFullMap && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/85 backdrop-blur-md p-4" onClick={() => setShowFullMap(false)}>
          <div className="hud-panel p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <div className="font-[Orbitron] text-xl glow-text">Galaxy Map</div>
              <button className="btn-cyber" onClick={() => setShowFullMap(false)}>Close</button>
            </div>
            <svg width="640" height="640" viewBox="0 0 640 640" className="block max-w-[88vw] max-h-[70vh]">
              <defs>
                <radialGradient id="bgmap" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#0a0a22" />
                  <stop offset="100%" stopColor="#01010a" />
                </radialGradient>
              </defs>
              <rect width="640" height="640" fill="url(#bgmap)" />
              <circle cx="320" cy="320" r="296" fill="none" stroke="rgba(120,220,255,0.55)" strokeWidth="2" />
              <circle cx="320" cy="320" r="296" fill="none" stroke="rgba(120,220,255,0.18)" strokeWidth="20" />
              {hazards.map((hz) => {
                const x = 320 + (hz.x / SAFE_RADIUS) * 296;
                const y = 320 + (hz.y / SAFE_RADIUS) * 296;
                if (Math.hypot(x - 320, y - 320) > 300) return null;
                if (hz.kind === "asteroid") {
                  return <circle key={hz.id} cx={x} cy={y} r={0.8} fill="rgba(180,180,180,0.35)" />;
                }
                const r = hz.kind === "star" ? 4 : hz.kind === "blackhole" ? 3.5 : 2.4;
                const fill = hz.kind === "blackhole" ? "#8b5cf6" : hz.kind === "star" ? "#facc15" : hz.color;
                return <circle key={hz.id} cx={x} cy={y} r={r} fill={fill} opacity={0.95} />;
              })}
              <circle cx={320 + (playerPos.x / SAFE_RADIUS) * 296} cy={320 + (playerPos.y / SAFE_RADIUS) * 296} r="6" fill={save.color} stroke="white" strokeWidth="2" />
            </svg>
            <div className="text-[10px] opacity-70 mt-2 text-center">
              ★ stars · ● black holes (instant death) · planets · You · arena {Math.round(GALAXY_SIZE/1000)}K units
            </div>
          </div>
        </div>
      )}

      {banned && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/85 backdrop-blur-md">
          <div className="text-center">
            <div className="font-[Orbitron] text-5xl text-red-400 glow-text">FULLY DESTROYED</div>
            <div className="mt-3 text-sm opacity-80">You lost all {DEATHS_BEFORE_BAN} lives in room <b>{roomCode}</b>.</div>
            <div className="mt-1 text-sm opacity-80">You can never re-enter this room.</div>
            <div className="mt-6 text-xs opacity-60">Returning to lobby…</div>
          </div>
        </div>
      )}

      {dead && !banned && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70 backdrop-blur-sm pointer-events-none">
          <div className="text-center">
            <div className="font-[Orbitron] text-5xl text-red-400 glow-text">DESTROYED</div>
            <div className="mt-2 text-sm opacity-80">Next life max HP: <b>{Math.round(100 * Math.max(0, 1 - 0.2 * deathCount))}%</b> · {livesRemaining} lives left</div>
            <div className="mt-6 font-[Orbitron] text-2xl">Respawn in {respawnIn}s</div>
          </div>
        </div>
      )}

      {showMenu && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/70 backdrop-blur-md">
          <div className="hud-panel p-6 w-[min(420px,92vw)]">
            <div className="font-[Orbitron] text-2xl glow-text mb-1">Pause Menu</div>
            <div className="text-xs opacity-70 mb-4">Pilot {pilotName} · Room {roomCode}</div>
            <div className="flex flex-col gap-2">
              <button className="btn-cyber" onClick={() => { setShowMenu(false); setShowHangar(true); }}>Open Shop</button>
              <button className="btn-cyber" onClick={() => { setShowMenu(false); setShowFullMap(true); }}>Open Galaxy Map</button>
              <button className={`btn-cyber ${mobileControls ? "accent" : ""}`} onClick={() => { setMobileControls((v) => !v); Sounds.click(); }}>
                Controls: {mobileControls ? "📱 Mobile (landscape)" : "⌨ PC (keyboard)"}
              </button>
              <div className="text-[10px] opacity-60 -mt-1">Tap to switch. Mobile shows on-screen joypad + buttons.</div>
              <button className="btn-cyber" onClick={() => setShowMenu(false)}>Resume</button>
              <button className="btn-cyber" style={{ borderColor: "rgba(255,80,80,0.5)", color: "#ffb0b0" }} onClick={onExit}>Exit Room</button>
            </div>
          </div>
        </div>
      )}

      {showHangar && !banned && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/80 backdrop-blur-md p-4">
          <div className="hud-panel p-5 w-[min(1100px,96vw)] h-[min(90vh,820px)] flex flex-col">
            <div className="flex justify-between items-center mb-3 gap-3 flex-wrap">
              <div>
                <div className="font-[Orbitron] text-2xl glow-text">Shop / Hangar</div>
                <div className="text-xs opacity-70">Planes buy one-by-one in order · rockets & shields buy freely</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-widest opacity-70">Color</label>
                <select className="px-2 py-1 bg-black/60 border border-[color:var(--color-border)] rounded text-xs"
                  value={save.color} onChange={(e) => pickColor(e.target.value)}>
                  {COLOR_OPTIONS.map((c, i) => (
                    <option key={c} value={c}>{["Red","Orange","Yellow","Green","Cyan","Blue","Purple","Pink","White","Steel"][i]}</option>
                  ))}
                </select>
                <span className="text-[10px] opacity-60">1c</span>
                <button className="btn-cyber" onClick={() => setShowHangar(false)}>Close</button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-3">
              {(["plane", "rocket", "shield"] as const).map((t) => (
                <button key={t}
                  className={`btn-cyber ${hangarTab === t ? "accent" : ""}`}
                  onClick={() => { setHangarTab(t); Sounds.click(); }}>
                  {t === "plane" ? `✈ Planes (${SHIPS.length})` : t === "rocket" ? `🚀 Rockets (${ROCKETS.length})` : `🛡 Shields (${SHIELDS.length})`}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              {hangarTab === "plane" && (
                <>
                  <div className="flex items-center justify-between mb-2 text-xs">
                    <div className="opacity-70">Tier {planePage * PLANES_PER_PAGE + 1} – {Math.min(SHIPS.length, (planePage+1) * PLANES_PER_PAGE)} of {SHIPS.length}</div>
                    <div className="flex gap-1">
                      <button className="btn-cyber text-[11px]" disabled={planePage === 0} onClick={() => setPlanePage((p) => Math.max(0, p - 1))}>« Prev</button>
                      <button className="btn-cyber text-[11px]" onClick={() => {
                        // jump to first locked
                        const firstLocked = SHIPS.findIndex((s) => !save.ownedShipIds.includes(s.id));
                        if (firstLocked >= 0) setPlanePage(Math.floor(firstLocked / PLANES_PER_PAGE));
                      }}>Next to Buy</button>
                      <button className="btn-cyber text-[11px]" disabled={planePage >= totalPages - 1} onClick={() => setPlanePage((p) => Math.min(totalPages - 1, p + 1))}>Next »</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                    {planeSlice.map((s) => {
                      const owned = save.ownedShipIds.includes(s.id);
                      const equipped = save.currentShipId === s.id;
                      const locked = !owned && s.id > 0 && !save.ownedShipIds.includes(s.id - 1);
                      const dp = diamondPrice(s);
                      return (
                        <div key={s.id} className={`hud-panel p-3 ${equipped ? "ring-2 ring-[color:var(--color-accent)]" : ""} ${locked ? "opacity-60" : ""}`}>
                          <div className="flex justify-between items-baseline">
                            <div className="font-[Orbitron] text-sm">#{s.id + 1} {s.name}</div>
                            {equipped && <span className="text-[9px] uppercase text-[color:var(--color-accent)]">In use</span>}
                          </div>
                          <div className="my-2 h-20 grid place-items-center">
                            <MiniShip color={save.color} ship={s} />
                          </div>
                          <div className="text-[10px] grid grid-cols-2 gap-x-2 opacity-80 mb-2">
                            <div>HP {s.hp}</div><div>Spd {Math.round(s.maxSpeed)}</div>
                            <div>Dmg {Math.round(s.bulletDmg)}</div><div>RoF {s.fireRate.toFixed(1)}/s</div>
                          </div>
                          {owned ? (
                            <button className="btn-cyber w-full justify-center" disabled={equipped} onClick={() => equipShip(s)}>{equipped ? "Equipped" : "Equip"}</button>
                          ) : locked ? (
                            <div className="text-center text-[10px] opacity-70">🔒 Buy #{s.id} to unlock</div>
                          ) : (
                            <div className="flex gap-1">
                              <button className="btn-cyber accent flex-1 justify-center" disabled={save.coins < s.price} onClick={() => buyShip(s, false)}>{s.price}c</button>
                              <button className="btn-cyber flex-1 justify-center" disabled={save.diamonds < dp} onClick={() => buyShip(s, true)}>{dp}♦</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {hangarTab === "rocket" && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {ROCKETS.map((r) => {
                    const owned = save.rockets[r.id] ?? 0;
                    const equipped = save.activeRocketId === r.id;
                    return (
                      <div key={r.id} className={`hud-panel p-3 ${equipped ? "ring-2 ring-[color:var(--color-accent)]" : ""}`}>
                        <div className="flex justify-between items-baseline">
                          <div className="font-[Orbitron] text-sm" style={{ color: r.color }}>🚀 #{r.id+1} {r.name}</div>
                          <div className="text-[10px] opacity-80">Owned ×<b>{owned}</b></div>
                        </div>
                        <div className="text-[10px] grid grid-cols-3 gap-x-2 opacity-80 my-2">
                          <div>Dmg {r.dmg}</div><div>Spd {r.speed}</div><div>Turn {r.turnRate.toFixed(1)}</div>
                        </div>
                        <div className="flex gap-1 flex-wrap">
                          {[1, 5, 10, 25].map((q) => (
                            <button key={"c" + q} className="btn-cyber accent flex-1 justify-center text-[11px]"
                              disabled={save.coins < r.coinPrice * q} onClick={() => buyRocket(r, false, q)}>
                              ×{q} {r.coinPrice * q}c
                            </button>
                          ))}
                        </div>
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {[1, 5, 10, 25].map((q) => (
                            <button key={"d" + q} className="btn-cyber flex-1 justify-center text-[11px]"
                              disabled={save.diamonds < r.diamondPrice * q} onClick={() => buyRocket(r, true, q)}>
                              ×{q} {r.diamondPrice * q}♦
                            </button>
                          ))}
                        </div>
                        <button className="btn-cyber w-full justify-center mt-2"
                          disabled={equipped}
                          onClick={() => { setSave((s) => ({ ...s, activeRocketId: r.id })); Sounds.click(); }}>
                          {equipped ? "Selected" : (r.id < 9 ? `Select (press ${r.id + 1})` : "Select")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {hangarTab === "shield" && (
                <>
                  <div className="hud-panel p-3 mb-2 text-xs flex justify-between items-center">
                    <div>Stored: <b className="text-cyan-300">{save.shieldHp}🛡</b> · Active cap {SHIELD_ACTIVE_CAP} · Press <b>F</b> to activate</div>
                    <div>Active type: <b style={{ color: SHIELDS[selectedShield].color }}>{SHIELDS[selectedShield].name}</b></div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {SHIELDS.map((sh) => {
                      const selected = selectedShield === sh.id;
                      return (
                        <div key={sh.id} className={`hud-panel p-3 ${selected ? "ring-2 ring-[color:var(--color-accent)]" : ""}`}>
                          <div className="flex justify-between items-baseline">
                            <div className="font-[Orbitron] text-sm" style={{ color: sh.color }}>🛡 #{sh.id+1} {sh.name}</div>
                            <div className="text-[10px] opacity-80">+{sh.hp} HP</div>
                          </div>
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {[1, 5, 10].map((q) => (
                              <button key={"sc"+q} className="btn-cyber accent flex-1 justify-center text-[11px]"
                                disabled={save.coins < sh.coinPrice * q} onClick={() => buyShield(sh, false, q)}>
                                ×{q} {sh.coinPrice * q}c
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {[1, 5, 10].map((q) => (
                              <button key={"sd"+q} className="btn-cyber flex-1 justify-center text-[11px]"
                                disabled={save.diamonds < sh.diamondPrice * q} onClick={() => buyShield(sh, true, q)}>
                                ×{q} {sh.diamondPrice * q}♦
                              </button>
                            ))}
                          </div>
                          <button className="btn-cyber w-full justify-center mt-2" disabled={selected}
                            onClick={() => { setSelectedShield(sh.id); Sounds.click(); }}>
                            {selected ? "Selected" : "Select"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {mobileControls && !banned && !showMenu && !showHangar && !showFullMap && (
        <TouchControls
          keysRef={keysRef}
          onShield={() => activateShieldRef.current()}
          onRocket={() => fireRocketRef.current()}
          onShop={() => { setShowHangar(true); Sounds.click(); }}
          onMap={() => { setShowFullMap(true); Sounds.click(); }}
        />
      )}
    </div>
  );
}

function TouchControls({
  keysRef, onShield, onRocket, onShop, onMap,
}: {
  keysRef: React.MutableRefObject<Set<string>>;
  onShield: () => void; onRocket: () => void; onShop: () => void; onMap: () => void;
}) {
  const hold = (key: string) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); keysRef.current.add(key); },
    onPointerUp:   (e: React.PointerEvent) => { e.preventDefault(); keysRef.current.delete(key); },
    onPointerCancel: () => { keysRef.current.delete(key); },
    onPointerLeave: (e: React.PointerEvent) => { if ((e.buttons & 1) === 0) keysRef.current.delete(key); },
  });
  const Btn = ({ k, label, cls = "" }: { k: string; label: string; cls?: string }) => (
    <button
      {...hold(k)}
      className={`select-none touch-none rounded-full border border-cyan-300/50 bg-black/55 backdrop-blur-sm text-cyan-100 font-[Orbitron] active:bg-cyan-400/30 ${cls}`}
      style={{ WebkitUserSelect: "none" }}
    >{label}</button>
  );
  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      {/* D-pad bottom-left */}
      <div className="absolute bottom-4 left-4 grid grid-cols-3 grid-rows-3 gap-1 pointer-events-auto" style={{ width: 168, height: 168 }}>
        <div />
        <Btn k="w" label="▲" cls="w-12 h-12 text-xl" />
        <div />
        <Btn k="a" label="◀" cls="w-12 h-12 text-xl" />
        <Btn k="backspace" label="■" cls="w-12 h-12 text-base" />
        <Btn k="d" label="▶" cls="w-12 h-12 text-xl" />
        <div />
        <Btn k="s" label="▼" cls="w-12 h-12 text-xl" />
        <div />
      </div>
      {/* Action cluster bottom-right */}
      <div className="absolute bottom-4 right-4 flex flex-col items-end gap-2 pointer-events-auto">
        <div className="flex gap-2">
          <button onPointerDown={(e) => { e.preventDefault(); onMap(); }} className="select-none touch-none rounded-full border border-cyan-300/50 bg-black/55 backdrop-blur-sm text-cyan-100 font-[Orbitron] text-[10px] w-14 h-10 active:bg-cyan-400/30">MAP</button>
          <button onPointerDown={(e) => { e.preventDefault(); onShop(); }} className="select-none touch-none rounded-full border border-amber-300/50 bg-black/55 backdrop-blur-sm text-amber-100 font-[Orbitron] text-[10px] w-14 h-10 active:bg-amber-400/30">SHOP</button>
        </div>
        <div className="flex gap-2 items-end">
          <Btn k="q" label="BOOST" cls="w-16 h-16 text-[11px]" />
          <button onPointerDown={(e) => { e.preventDefault(); onShield(); }} className="select-none touch-none rounded-full border border-cyan-300/60 bg-black/55 backdrop-blur-sm text-cyan-100 font-[Orbitron] text-[11px] w-16 h-16 active:bg-cyan-400/30">🛡</button>
          <button onPointerDown={(e) => { e.preventDefault(); onRocket(); }} className="select-none touch-none rounded-full border border-fuchsia-300/60 bg-black/55 backdrop-blur-sm text-fuchsia-100 font-[Orbitron] text-[11px] w-16 h-16 active:bg-fuchsia-400/30">🚀</button>
          <Btn k=" " label="FIRE" cls="w-20 h-20 text-sm border-red-300/60 text-red-100 active:bg-red-400/30" />
        </div>
      </div>
    </div>
  );
}

function MiniShip({ color, ship }: { color: string; ship: Ship }) {
  return (
    <svg width="74" height="74" viewBox="-40 -40 80 80">
      <g transform="rotate(-90)">
        {shipSvgPaths(ship.shape, color)}
      </g>
    </svg>
  );
}
function shipSvgPaths(shape: number, color: string) {
  const stroke = "rgba(255,255,255,0.45)";
  switch (shape) {
    case 1:
      return (<>
        <polygon points="22,0 -10,-16 -4,0 -10,16" fill={color} stroke={stroke} />
        <polygon points="-10,-16 -22,-8 -16,-2 -10,-6" fill={color} stroke={stroke} />
        <polygon points="-10,16 -22,8 -16,2 -10,6" fill={color} stroke={stroke} />
        <circle cx="6" cy="0" r="4" fill="#9ee7ff" opacity="0.9" />
        <rect x="-14" y="-3" width="4" height="6" fill="#ffb060" />
      </>);
    case 2:
      return (<>
        <polygon points="26,0 -8,-12 4,0 -8,12" fill={color} stroke={stroke} />
        <polygon points="-2,-10 -18,-18 -14,-6 -4,-4" fill={color} stroke={stroke} />
        <polygon points="-2,10 -18,18 -14,6 -4,4" fill={color} stroke={stroke} />
        <circle cx="10" cy="0" r="3.5" fill="#9ee7ff" />
      </>);
    case 3:
      return (<>
        <polygon points="20,0 -4,-14 -20,0 -4,14" fill={color} stroke={stroke} />
        <rect x="-12" y="-18" width="6" height="10" fill={color} stroke={stroke} />
        <rect x="-12" y="8" width="6" height="10" fill={color} stroke={stroke} />
        <circle cx="2" cy="0" r="4" fill="#9ee7ff" />
        <rect x="-22" y="-2" width="6" height="4" fill="#ffb060" />
      </>);
    case 4:
      return (<>
        <polygon points="24,0 -14,-10 -6,0 -14,10" fill={color} stroke={stroke} />
        <polygon points="0,-8 -20,-6 -18,-2 -2,-3" fill={color} stroke={stroke} />
        <polygon points="0,8 -20,6 -18,2 -2,3" fill={color} stroke={stroke} />
        <line x1="-6" y1="0" x2="-22" y2="0" stroke={stroke} strokeWidth="2" />
        <circle cx="8" cy="0" r="3.5" fill="#9ee7ff" />
      </>);
    default:
      return (<>
        <polygon points="22,0 -10,-12 -4,0 -10,12" fill={color} stroke={stroke} />
        <polygon points="-4,-6 -16,-12 -12,-2" fill={color} stroke={stroke} />
        <polygon points="-4,6 -16,12 -12,2" fill={color} stroke={stroke} />
        <circle cx="8" cy="0" r="3.5" fill="#9ee7ff" />
        <rect x="-14" y="-2" width="4" height="4" fill="#ffb060" />
      </>);
  }
}

function drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, thrust: boolean, ship: Ship, zoom: number, isSelf = false) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  const sz = ship.size;
  const s = sz / 30;

  if (thrust) {
    ctx.fillStyle = "rgba(255,180,80,0.85)";
    ctx.beginPath();
    ctx.moveTo(-10 * s, -4 * s);
    ctx.lineTo((-22 - Math.random() * 8) * s, 0);
    ctx.lineTo(-10 * s, 4 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,180,0.7)";
    ctx.beginPath();
    ctx.moveTo(-10 * s, -2 * s);
    ctx.lineTo(-16 * s, 0);
    ctx.lineTo(-10 * s, 2 * s);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = color;
  ctx.strokeStyle = isSelf ? "#fff" : "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1.5 / zoom;

  const shape = ship.shape;
  ctx.beginPath();
  if (shape === 1) {
    ctx.moveTo(-10 * s, -16 * s); ctx.lineTo(-22 * s, -8 * s); ctx.lineTo(-16 * s, -2 * s); ctx.lineTo(-10 * s, -6 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-10 * s, 16 * s); ctx.lineTo(-22 * s, 8 * s); ctx.lineTo(-16 * s, 2 * s); ctx.lineTo(-10 * s, 6 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (shape === 2) {
    ctx.moveTo(-2 * s, -10 * s); ctx.lineTo(-18 * s, -18 * s); ctx.lineTo(-14 * s, -6 * s); ctx.lineTo(-4 * s, -4 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-2 * s, 10 * s); ctx.lineTo(-18 * s, 18 * s); ctx.lineTo(-14 * s, 6 * s); ctx.lineTo(-4 * s, 4 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (shape === 3) {
    ctx.rect(-12 * s, -18 * s, 6 * s, 10 * s);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.rect(-12 * s, 8 * s, 6 * s, 10 * s);
    ctx.fill(); ctx.stroke();
  } else if (shape === 4) {
    ctx.moveTo(0, -8 * s); ctx.lineTo(-20 * s, -6 * s); ctx.lineTo(-18 * s, -2 * s); ctx.lineTo(-2 * s, -3 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 8 * s); ctx.lineTo(-20 * s, 6 * s); ctx.lineTo(-18 * s, 2 * s); ctx.lineTo(-2 * s, 3 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else {
    ctx.moveTo(-4 * s, -6 * s); ctx.lineTo(-16 * s, -12 * s); ctx.lineTo(-12 * s, -2 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-4 * s, 6 * s); ctx.lineTo(-16 * s, 12 * s); ctx.lineTo(-12 * s, 2 * s); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  ctx.beginPath();
  if (shape === 2) {
    ctx.moveTo(26 * s, 0); ctx.lineTo(-8 * s, -12 * s); ctx.lineTo(4 * s, 0); ctx.lineTo(-8 * s, 12 * s);
  } else if (shape === 3) {
    ctx.moveTo(20 * s, 0); ctx.lineTo(-4 * s, -14 * s); ctx.lineTo(-20 * s, 0); ctx.lineTo(-4 * s, 14 * s);
  } else if (shape === 4) {
    ctx.moveTo(24 * s, 0); ctx.lineTo(-14 * s, -10 * s); ctx.lineTo(-6 * s, 0); ctx.lineTo(-14 * s, 10 * s);
  } else {
    ctx.moveTo(22 * s, 0); ctx.lineTo(-10 * s, -12 * s); ctx.lineTo(-4 * s, 0); ctx.lineTo(-10 * s, 12 * s);
  }
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#9ee7ff";
  ctx.beginPath();
  ctx.arc(6 * s, 0, 3.5 * s, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}
