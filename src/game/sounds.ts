// WebAudio synth — local only (never broadcast). Browser autoplay policy:
// first user gesture (the Launch button) resumes the context.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

export function initAudio() {
  if (ctx) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AC = (window.AudioContext || (window as any).webkitAudioContext);
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);
}

export function setVolume(v: number) {
  if (master) master.gain.value = Math.max(0, Math.min(1, v));
}

function tone(opts: { freq: number; dur: number; type?: OscillatorType; gain?: number; sweepTo?: number }) {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type ?? "square";
  osc.frequency.value = opts.freq;
  if (opts.sweepTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, ctx.currentTime + opts.dur);
  }
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(opts.gain ?? 0.3, ctx.currentTime + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + opts.dur);
  osc.connect(g); g.connect(master);
  osc.start();
  osc.stop(ctx.currentTime + opts.dur + 0.05);
}

function noise(dur: number, gain = 0.3, filterFreq = 800) {
  if (!ctx || !master) return;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = filterFreq;
  const g = ctx.createGain(); g.gain.value = gain;
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(); src.stop(ctx.currentTime + dur);
}

export const Sounds = {
  shoot:   () => tone({ freq: 880, sweepTo: 220, dur: 0.08, type: "square", gain: 0.18 }),
  hit:     () => tone({ freq: 320, sweepTo: 120, dur: 0.12, type: "sawtooth", gain: 0.25 }),
  explode: () => { noise(0.5, 0.5, 1200); tone({ freq: 120, sweepTo: 40, dur: 0.5, type: "sawtooth", gain: 0.3 }); },
  pickupCoin:    () => tone({ freq: 880, sweepTo: 1320, dur: 0.1, type: "triangle", gain: 0.25 }),
  pickupDiamond: () => { tone({ freq: 1320, sweepTo: 1760, dur: 0.18, type: "triangle", gain: 0.3 });
                          setTimeout(() => tone({ freq: 1760, sweepTo: 2200, dur: 0.18, type: "triangle", gain: 0.3 }), 80); },
  boost:   () => tone({ freq: 220, sweepTo: 660, dur: 0.3, type: "sawtooth", gain: 0.2 }),
  buy:     () => { tone({ freq: 660, dur: 0.08, type: "square", gain: 0.2 });
                    setTimeout(() => tone({ freq: 990, dur: 0.12, type: "square", gain: 0.2 }), 70); },
  respawn: () => tone({ freq: 220, sweepTo: 880, dur: 0.4, type: "sine", gain: 0.3 }),
  death:   () => { noise(0.6, 0.6, 600); tone({ freq: 220, sweepTo: 55, dur: 0.6, type: "sawtooth", gain: 0.35 }); },
  click:   () => tone({ freq: 660, dur: 0.04, type: "square", gain: 0.15 }),
  rocket:  () => { tone({ freq: 180, sweepTo: 520, dur: 0.5, type: "sawtooth", gain: 0.28 }); noise(0.4, 0.25, 900); },
  shieldOn:() => tone({ freq: 440, sweepTo: 1320, dur: 0.3, type: "sine", gain: 0.3 }),
};
