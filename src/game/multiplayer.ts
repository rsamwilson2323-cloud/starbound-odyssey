import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type RemoteShip = {
  id: string;
  name: string;
  color: string;
  shipId: number;
  x: number;
  y: number;
  angle: number;
  thrust: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  lastSeen: number;
};

export type SelfBroadcast = Omit<RemoteShip, "lastSeen">;

export type ShootEvt = {
  shooter: string;
  bid: string;          // bullet id
  x: number; y: number;
  vx: number; vy: number;
  dmg: number;
  color: string;
  ttl: number;
};

export type HitEvt = { target: string; shooter: string; dmg: number };
export type DeathEvt = { victim: string; killer: string | null; x: number; y: number; coins: number; diamonds: number };
export type ClaimEvt = { id: string };           // coin/loot claimed

type Handlers = {
  onPeers: (peers: Map<string, RemoteShip>) => void;
  onShoot: (e: ShootEvt) => void;
  onHit: (e: HitEvt) => void;
  onDeath: (e: DeathEvt) => void;
  onCoinClaim: (id: string) => void;
  onLootClaim: (id: string) => void;
};

export function createMultiplayer(roomCode: string, self: SelfBroadcast, h: Handlers) {
  const peers = new Map<string, RemoteShip>();
  let lastSent = 0;
  const channel: RealtimeChannel = supabase.channel(`room:${roomCode}`, {
    config: { broadcast: { self: false }, presence: { key: self.id } },
  });

  channel.on("broadcast", { event: "ship" }, ({ payload }) => {
    const p = payload as SelfBroadcast;
    if (!p?.id || p.id === self.id) return;
    peers.set(p.id, { ...p, lastSeen: performance.now() });
    h.onPeers(new Map(peers));
  });
  channel.on("broadcast", { event: "shoot" }, ({ payload }) => {
    const p = payload as ShootEvt;
    if (p.shooter === self.id) return;
    h.onShoot(p);
  });
  channel.on("broadcast", { event: "hit" }, ({ payload }) => h.onHit(payload as HitEvt));
  channel.on("broadcast", { event: "death" }, ({ payload }) => h.onDeath(payload as DeathEvt));
  channel.on("broadcast", { event: "coinClaim" }, ({ payload }) => h.onCoinClaim((payload as ClaimEvt).id));
  channel.on("broadcast", { event: "lootClaim" }, ({ payload }) => h.onLootClaim((payload as ClaimEvt).id));

  channel.on("presence", { event: "leave" }, ({ key }) => {
    peers.delete(key as string);
    h.onPeers(new Map(peers));
  });

  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await channel.track({ id: self.id, name: self.name });
  });

  function sendShip(state: SelfBroadcast, force = false) {
    const now = performance.now();
    if (!force && now - lastSent < 70) return;
    lastSent = now;
    channel.send({ type: "broadcast", event: "ship", payload: state });
  }
  function sendShoot(e: ShootEvt) { channel.send({ type: "broadcast", event: "shoot", payload: e }); }
  function sendHit(e: HitEvt) { channel.send({ type: "broadcast", event: "hit", payload: e }); }
  function sendDeath(e: DeathEvt) { channel.send({ type: "broadcast", event: "death", payload: e }); }
  function sendCoinClaim(id: string) { channel.send({ type: "broadcast", event: "coinClaim", payload: { id } }); }
  function sendLootClaim(id: string) { channel.send({ type: "broadcast", event: "lootClaim", payload: { id } }); }

  function pruneStale() {
    const now = performance.now();
    let changed = false;
    for (const [k, v] of peers) {
      if (now - v.lastSeen > 6000) { peers.delete(k); changed = true; }
    }
    if (changed) h.onPeers(new Map(peers));
  }
  function dispose() { supabase.removeChannel(channel); }

  return { sendShip, sendShoot, sendHit, sendDeath, sendCoinClaim, sendLootClaim, pruneStale, dispose };
}

export function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
