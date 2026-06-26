import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import GameCanvas from "@/game/GameCanvas";
import { makeRoomCode } from "@/game/multiplayer";
import { initAudio, Sounds } from "@/game/sounds";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Stellar Drift — Multiplayer Space Combat" },
      { name: "description", content: "Fly, shoot, loot. Join a room with friends in a shared galaxy. 50 ships, coins, diamonds and a big map." },
      { property: "og:title", content: "Stellar Drift — Multiplayer Space Combat" },
      { property: "og:description", content: "Make a room code, share the link, and fight together among planets and black holes." },
    ],
  }),
  component: Index,
});

const PILOT_ID_KEY = "stellar_pilot_id";
const PILOT_NAME_KEY = "stellar_pilot_name";
const ROOM_HISTORY_KEY = "stellar_room_history";
const SESSION_KEY = "stellar_session";

function makePilotId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `pilot-${Date.now().toString(36)}-${random}`;
}

function updateRoomQuery(room: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (room) url.searchParams.set("room", room);
  else url.searchParams.delete("room");
  window.history.replaceState({}, "", url.toString());
}

type RoomHistoryEntry = { code: string; ts: number };
function loadHistory(): RoomHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ROOM_HISTORY_KEY) || "[]");
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
      return (raw as string[]).map((code) => ({ code, ts: 0 }));
    }
    return raw as RoomHistoryEntry[];
  } catch { return []; }
}
function pushHistory(code: string) {
  const list = loadHistory().filter((r) => r.code !== code);
  list.unshift({ code, ts: Date.now() });
  localStorage.setItem(ROOM_HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
}
function formatTs(ts: number) {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today · ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

function Index() {
  const [mounted, setMounted] = useState(false);
  const [pilotId, setPilotId] = useState("");
  const [name, setName] = useState("");
  const [lockedName, setLockedName] = useState<string | null>(null);
  const [room, setRoom] = useState("");
  const [history, setHistory] = useState<RoomHistoryEntry[]>([]);
  const [inGame, setInGame] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    let id = localStorage.getItem(PILOT_ID_KEY);
    if (!id) { id = makePilotId(); localStorage.setItem(PILOT_ID_KEY, id); }
    setPilotId(id);
    const savedName = localStorage.getItem(PILOT_NAME_KEY) || "";
    if (savedName) { setLockedName(savedName); setName(savedName); }
    setHistory(loadHistory());
    const url = new URL(window.location.href);
    const r = url.searchParams.get("room");
    if (r) setRoom(r.toUpperCase());

    // Restore in-game session so HMR / remounts don't kick back to lobby
    try {
      const sess = sessionStorage.getItem(SESSION_KEY);
      if (sess) {
        const s = JSON.parse(sess);
        if (s.name && s.room && savedName) {
          setName(s.name); setRoom(s.room); setInGame(true);
        }
      }
    } catch {}
  }, []);

  if (!mounted) {
    return (
      <div className="grid place-items-center min-h-screen">
        <div className="font-[Orbitron] tracking-[0.3em] text-[color:var(--color-primary)] glow-text">BOOTING…</div>
      </div>
    );
  }

  if (inGame && pilotId && name && room) {
    return <GameCanvas pilotId={pilotId} pilotName={name} roomCode={room} onExit={() => {
      sessionStorage.removeItem(SESSION_KEY);
      updateRoomQuery(room);
      setInGame(false);
    }} />;
  }

  function generate() { setRoom(makeRoomCode()); Sounds.click(); }
  function launch() {
    const n = (lockedName ?? name).trim();
    const r = room.trim().toUpperCase();
    if (!n) { setError("Enter a pilot name"); return; }
    if (n.length > 16) { setError("Name max 16 chars"); return; }
    if (!/^[A-Z0-9]{4,8}$/.test(r)) { setError("Room code: 4-8 letters/numbers"); return; }
    if (!lockedName) { localStorage.setItem(PILOT_NAME_KEY, n); setLockedName(n); }
    pushHistory(r);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ name: n, room: r }));
    updateRoomQuery(r);
    setError(null);
    initAudio(); Sounds.click();
    setRoom(r); setName(n); setInGame(true);
  }
  function copyLink() {
    const r = room.trim().toUpperCase();
    if (!r) return;
    const url = `${window.location.origin}/?room=${r}`;
    navigator.clipboard?.writeText(url);
    setError("Link copied — share it with friends");
    setTimeout(() => setError(null), 2000);
  }
  function clearHistory() {
    localStorage.removeItem(ROOM_HISTORY_KEY); setHistory([]);
  }
  function changePilot() {
    if (!confirm("Reset pilot name? Your progress stays linked to this device.")) return;
    localStorage.removeItem(PILOT_NAME_KEY); setLockedName(null); setName("");
  }

  return (
    <div className="min-h-screen grid place-items-center p-4 overflow-y-auto">
      <div className="hud-panel p-8 w-[min(440px,96vw)] my-4">
        <div className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--color-primary)] glow-text">STELLAR DRIFT</div>
        <h1 className="font-[Orbitron] text-3xl mt-1 glow-text">Launch Bay</h1>
        <p className="text-sm opacity-75 mt-2 leading-relaxed">
          One pilot per device. Create or join a room — same code = same match. Share your link to invite friends.
        </p>

        <label className="block mt-5 text-[10px] uppercase tracking-widest opacity-70">Pilot name {lockedName && <span className="text-[color:var(--color-accent)]">· locked</span>}</label>
        <div className="flex gap-2 mt-1">
          <input
            className="flex-1 px-3 py-2 bg-black/40 border border-[color:var(--color-border)] rounded font-mono disabled:opacity-70"
            maxLength={16} value={name} onChange={(e) => setName(e.target.value)} placeholder="callsign"
            disabled={!!lockedName}
            onKeyDown={(e) => { if (e.key === "Enter") launch(); }}
          />
          {lockedName && <button className="btn-cyber text-[10px]" onClick={changePilot}>Reset</button>}
        </div>

        <label className="block mt-4 text-[10px] uppercase tracking-widest opacity-70">Room code</label>
        <div className="flex gap-2 mt-1">
          <input
            className="flex-1 px-3 py-2 bg-black/40 border border-[color:var(--color-border)] rounded font-mono uppercase tracking-widest"
            maxLength={8} value={room} onChange={(e) => setRoom(e.target.value.toUpperCase())}
            placeholder="ABC123"
            onKeyDown={(e) => { if (e.key === "Enter") launch(); }}
          />
          <button className="btn-cyber" onClick={generate}>Generate</button>
        </div>

        {room && (
          <button className="mt-2 text-[10px] opacity-70 hover:opacity-100 underline" onClick={copyLink}>
            Copy invite link
          </button>
        )}

        {history.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest opacity-70">Recent rooms</div>
              <button className="text-[9px] opacity-60 hover:opacity-100 underline" onClick={clearHistory}>clear</button>
            </div>
            <div className="flex flex-col gap-1 mt-2">
              {history.map((h) => (
                <div key={h.code} className="flex items-center gap-2">
                  <button className="btn-cyber text-[10px] py-1 px-2 flex-1 justify-start" onClick={() => setRoom(h.code)}>{h.code}</button>
                  <span className="text-[9px] opacity-60 font-mono">{formatTs(h.ts)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <div className="mt-3 text-xs text-amber-300">{error}</div>}

        <button className="btn-cyber accent w-full justify-center mt-5 py-3 text-base" onClick={launch}>
          Launch
        </button>

        <div className="mt-5 text-[10px] opacity-60 leading-relaxed">
          W/↑ thrust · S/↓ reverse · A D ←→ turn · Backspace brake · Space fire · Hold Q for boost (5s) · Esc menu
        </div>
      </div>
    </div>
  );
}
