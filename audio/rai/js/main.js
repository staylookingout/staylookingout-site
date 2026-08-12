import { VoiceEngine, freqForMidiNote } from "./synth.js";
import { MidiManager } from "./midi.js";
import { buildKeyboard } from "./keyboard.js";
import { makeKnob, makeVoicePad, drawLedBars } from "./ui.js";

const state = {
  octave: 4,
  padPitchRange: [48, 84], // 3-octave glissando range for the XY pad
  padHeldNote: null,
};

let ctx = null;
let engine = null;
let midi = null;
let started = false;

const appEl = document.querySelector(".app");

const els = {
  midiBtn: document.getElementById("midi-btn"),
  midiDot: document.getElementById("midi-dot"),
  midiLabel: document.getElementById("midi-label"),
  midiNote: document.getElementById("midi-note"),
  voicePad: document.getElementById("voice-pad"),
  voicePadCursor: document.getElementById("voice-pad-cursor"),
  ledCanvas: document.getElementById("led-canvas"),
  voiceboxReadout: document.getElementById("voicebox-readout"),
  keyboard: document.getElementById("keyboard"),
  octLabel: document.getElementById("oct-label"),
  octUp: document.getElementById("oct-up"),
  octDown: document.getElementById("oct-down"),
};

// Kick off the looping hero video immediately (independent of the audio
// engine, which stays gated behind a user gesture per browser policy).
// Muted autoplay is broadly allowed without interaction; if a browser still
// blocks it, the <video poster> (the static portrait) is shown instead.
const portraitVideo = document.getElementById("portrait");
if (portraitVideo) {
  portraitVideo.muted = true;
  portraitVideo.play?.().catch(() => {
    // Autoplay blocked — fall back to starting it on first interaction.
    const startVideo = () => {
      portraitVideo.play().catch(() => {});
    };
    ["pointerdown", "keydown"].forEach((evt) =>
      window.addEventListener(evt, startVideo, { once: true, passive: true })
    );
  });
}

// REALM logo: no steady glow — just an occasional, randomly-timed soft
// breath of light, kept infrequent rather than a constant/looping effect.
function scheduleLogoBreath() {
  const logo = document.querySelector(".realm-logo-link");
  if (!logo) return;
  const MIN_GAP_MS = 16000;
  const MAX_GAP_MS = 34000;
  const HOLD_MIN_MS = 2000;
  const HOLD_MAX_MS = 3200;

  function pulse() {
    logo.classList.add("breathe");
    const hold = HOLD_MIN_MS + Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
    setTimeout(() => logo.classList.remove("breathe"), hold);
    const nextGap = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
    setTimeout(pulse, nextGap);
  }
  setTimeout(pulse, 5000 + Math.random() * 6000);
}
scheduleLogoBreath();

/**
 * Creates the AudioContext/VoiceEngine on first real interaction (browser
 * autoplay policy requires a user gesture). Idempotent and synchronous, so
 * every control calls this as step one of its own handler — no reliance on
 * event-listener ordering/races between a control's own listener and a
 * separate global "first interaction" listener.
 */
function ensureAudio() {
  if (!started) {
    started = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    engine = new VoiceEngine(ctx);
    engine.connect(ctx.destination);
    engine.start();
    // Some browsers (notably iOS Safari) suspend an AudioContext when the
    // tab/app is backgrounded and don't always auto-resume it on return.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && ctx?.state === "suspended") {
        ctx.resume?.().catch(() => {});
      }
    });
    // The knobs rendered their visuals at page load without touching the
    // (nonexistent) engine — now that it exists, push their current
    // values into it once.
    Object.values(knobHandles).forEach((h) => h.setValue(h.getValue()));
    if (location.search.includes("debug")) window.__rai = { engine, ctx, midi };
  }

  // Retry resume() on every call, not just the first — iOS Safari has a
  // documented history of not reliably honoring resume() when it's called
  // from a pointerdown/touchstart-driven gesture (it wants touchend/click).
  // Our Voice Pad and keyboard both fire on pointerdown, so a user's very
  // first tap could hit exactly that case; without a retry, `started`
  // being true forever meant we'd never try again and stayed silently
  // stuck "suspended" — cheap no-op once actually running.
  if (ctx && ctx.state !== "running") {
    ctx.resume?.().catch(() => {});
    // Also re-nudges iOS into the "playback" audio session category (see
    // the comment on #ios-audio-unlock in index.html) so the hardware
    // silent switch doesn't mute RAI's output — in case the first play()
    // attempt was similarly not honored, or iOS paused it.
    const unlockEl = document.getElementById("ios-audio-unlock");
    if (unlockEl?.paused) unlockEl.play().catch(() => {});
  }
}

// Give resume() more chances to actually take on iOS: every subsequent
// touchend/click across the app (not just the controls that call
// ensureAudio() directly) retries it, cheaply, until ctx.state is
// "running". Not `once` — see the comment inside ensureAudio() above.
["touchend", "click", "pointerdown", "keydown"].forEach((evt) =>
  window.addEventListener(evt, ensureAudio, { passive: true })
);

const knobHandles = {};
// Mirrors each knob's data-value in index.html — the "factory" state the
// (rAI) reset button restores.
const DEFAULT_KNOB_VALUES = { glide: 0.25, delay: 0.3, voice: 0, spread: 1 };
const DEFAULT_OCTAVE = 4;

// Build all UI immediately at page load — it must be visible and usable
// before any audio has started. Only the callbacks that actually produce
// sound reach into `engine`, and they call ensureAudio() first.
function buildUI() {
  knobHandles.glide = makeKnob(document.getElementById("knob-glide"), {
    onChange: (v) => engine?.setGlideTime(v * 1.2), // 0-1.2s
  });
  knobHandles.delay = makeKnob(document.getElementById("knob-delay"), {
    onChange: (v) => engine?.setDelayMix(v),
  });
  knobHandles.voice = makeKnob(document.getElementById("knob-voice"), {
    onChange: (v) => engine?.setVoiceCharacter(v),
  });
  knobHandles.spread = makeKnob(document.getElementById("knob-spread"), {
    onChange: (v) => engine?.setFormantSpread(v),
  });

  makeVoicePad(els.voicePad, els.voicePadCursor, {
    onMove: (x, y) => {
      ensureAudio();
      engine.setVowelY(y);
      const [lo, hi] = state.padPitchRange;
      const midiNote = lo + x * (hi - lo);
      engine.noteOn(freqForMidiNote(midiNote), 0.85);
    },
    onEngage: () => {},
    onRelease: () => engine?.noteOff(),
  });

  const kb = buildKeyboard(els.keyboard, {
    onNoteOn: (note, vel) => {
      ensureAudio();
      engine.setNoteFromMidi(note, vel);
    },
    onNoteOff: (note) => engine?.noteOff(),
    getOctave: () => state.octave,
  });

  els.octUp.addEventListener("click", () => setOctave(state.octave + 1));
  els.octDown.addEventListener("click", () => setOctave(state.octave - 1));

  // (rAI) — full reset: every knob and the octave snap back to their
  // defaults, any held note cuts off, and forcing the video back to its
  // loop point (t=0) re-uses the exact same rising-edge logic that drives
  // the automatic loop transition (see updatePortraitFade below) — so the
  // shake, scanline/color-split flash, and particle burst all fire for
  // free, whole-screen, in sync with the reset.
  document.getElementById("rai-reset")?.addEventListener("click", () => {
    ensureAudio();
    Object.entries(DEFAULT_KNOB_VALUES).forEach(([key, v]) => knobHandles[key]?.setValue(v));
    setOctave(DEFAULT_OCTAVE);
    engine?.noteOff();
    wasGlitching = false; // force a fresh rising edge even if already mid-window
    if (portraitVideo) portraitVideo.currentTime = 0;
  });

  midi = new MidiManager({
    onNoteOn: (note, vel) => {
      ensureAudio();
      engine.setNoteFromMidi(note, vel);
      kb.highlightExternal(note, true);
    },
    onNoteOff: (note) => {
      engine?.noteOff();
      kb.highlightExternal(note, false);
    },
    onPitchBend: (v) => engine?.setVowelY((v + 1) / 2), // -1..1 -> 0..1
    onCC: (cc, v) => {
      if (!engine) return;
      switch (cc) {
        case 1: engine.setVibratoDepth(v); break;   // vibrato
        case 5: engine.setGlideTime(v * 1.2); break; // glide
        case 7: engine.out.gain.setTargetAtTime(v, ctx.currentTime, 0.02); break; // volume
        case 12: engine.setDelayMix(v); break;       // delay mix
        case 13: engine.setVoiceCharacter(v * 2 - 1); break; // voice character
        default: break;
      }
    },
  });

  setupMidiButton();
}

function setOctave(o) {
  state.octave = Math.min(7, Math.max(1, o));
  els.octLabel.textContent = `Octave ${state.octave}`;
}

function setupMidiButton() {
  if (!midi.supported) {
    els.midiBtn.classList.add("unsupported");
    els.midiLabel.textContent = "MIDI unsupported";
    els.midiNote.textContent =
      "Web MIDI isn't available in this browser (this is expected on iPhone Safari). " +
      "Use the on-screen keyboard or Voice Pad to play — on desktop Chrome/Edge/Safari, " +
      "or Android Chrome with a USB-OTG adapter, MIDI controllers will connect here.";
    els.midiBtn.disabled = true;
    return;
  }
  els.midiBtn.addEventListener("click", async () => {
    ensureAudio();
    els.midiLabel.textContent = "Connecting…";
    const result = await midi.connect();
    if (result.error) {
      els.midiLabel.textContent = "MIDI blocked";
      els.midiNote.textContent = "MIDI access was blocked or denied by the browser.";
      return;
    }
    els.midiBtn.classList.add("connected");
    const names = midi.deviceNames;
    els.midiLabel.textContent = names.length ? names[0] : "No device";
    els.midiNote.textContent = names.length
      ? `Connected: ${names.join(", ")}`
      : "MIDI is ready — plug in a controller to play the full range.";
  });
}

let phase = 0;
let smoothedLevel = 0;
function animateLeds() {
  phase += 0.045;
  // Breathes gently even before the engine exists (nothing played yet) —
  // same idle animation either way, live level just takes over once sound
  // starts.
  const breathing = Math.sin(phase * 0.6) * 0.12 + 0.16;
  let displayLevel = breathing;

  if (engine) {
    const raw = engine.getLevel();
    const rate = raw > smoothedLevel ? 0.35 : 0.08;
    smoothedLevel += (raw - smoothedLevel) * rate;
    displayLevel = engine.isSounding ? Math.max(smoothedLevel * 3, 0.12) : breathing;
    els.voiceboxReadout.textContent = engine.vowelLabel;
  }

  drawLedBars(els.ledCanvas, displayLevel, phase);
  requestAnimationFrame(animateLeds);
}

// Safe, no-op-if-unsupported haptic pulse (Android Chrome mainly; iOS
// Safari and most desktop browsers just silently ignore this). Browsers
// also block vibrate() entirely until the user has interacted with the
// page at least once — the glitch's own trigger is autonomous (driven by
// video playback, not a click), so track that separately rather than
// letting it log a blocked-call warning on every pre-interaction loop.
let hasInteracted = false;
["pointerdown", "keydown"].forEach((evt) =>
  window.addEventListener(evt, () => { hasInteracted = true; }, { once: true, passive: true })
);
function haptic(pattern) {
  if (!hasInteracted) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignore */
  }
}

// --- Glitch vector-line burst ---
// White/pink/purple line streaks that shoot outward from the voicebox
// (RAI's breathing pulse, under her chin), traveling in straight radial
// lines until each one is fully off-screen. Spawned once right as the
// glitch window opens.
const particleCanvas = document.getElementById("glitch-particles");
const pctx = particleCanvas?.getContext("2d");
const voiceboxEl = document.getElementById("voicebox");
const PARTICLE_COLORS = ["#ffffff", "#ff6ec7", "#9b6cf6"];
let particles = [];

function resizeParticleCanvas() {
  // Sized to the .app column itself, not the browser viewport — .app-glitch
  // and .glitch-particles are `position: absolute` within it (see CSS).
  if (!particleCanvas || !appEl) return;
  particleCanvas.width = appEl.offsetWidth;
  particleCanvas.height = appEl.offsetHeight;
}
window.addEventListener("resize", resizeParticleCanvas);

function spawnGlitchParticles() {
  if (!particleCanvas || !appEl || !voiceboxEl) return;
  resizeParticleCanvas(); // guard against any layout change since last resize

  // Burst origin: the voicebox's center (RAI's breathing pulse, under her
  // chin — lower than the stage's overall center), expressed in
  // canvas-local coordinates so it stays correctly placed regardless of
  // how wide the actual browser window is.
  const appRect = appEl.getBoundingClientRect();
  const voiceboxRect = voiceboxEl.getBoundingClientRect();
  const originX = voiceboxRect.left + voiceboxRect.width / 2 - appRect.left;
  const originY = voiceboxRect.top + voiceboxRect.height / 2 - appRect.top;
  // Line lengths (below) can exceed the canvas, so use its diagonal as the
  // "fully off-screen" removal threshold.
  const maxDist = Math.hypot(particleCanvas.width, particleCanvas.height);

  const count = 70;
  for (let i = 0; i < count; i++) {
    particles.push({
      originX,
      originY,
      angle: Math.random() * Math.PI * 2,
      headDist: 0, // distance of the streak's leading tip from origin
      speed: 500 + Math.random() * 900, // px/s the tip travels outward
      length: 40 + Math.random() * 110, // streak length in px
      width: 1.4 + Math.random() * 1.8,
      color: PARTICLE_COLORS[(Math.random() * PARTICLE_COLORS.length) | 0],
      age: 0,
      maxDist,
    });
  }
}

function updateAndDrawParticles(dt) {
  if (!pctx) return;
  pctx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  particles = particles.filter((p) => p.headDist - p.length < p.maxDist);
  for (const p of particles) {
    p.age += dt;
    p.headDist += p.speed * dt;
    const tailDist = Math.max(0, p.headDist - p.length);
    const dx = Math.cos(p.angle);
    const dy = Math.sin(p.angle);

    // Quick fade-in only — they stay essentially opaque until they exit
    // the canvas, rather than timing out mid-screen.
    const alpha = Math.min(1, p.age / 0.05);

    pctx.globalAlpha = alpha;
    pctx.strokeStyle = p.color;
    pctx.lineWidth = p.width;
    pctx.lineCap = "round";
    pctx.beginPath();
    pctx.moveTo(p.originX + dx * tailDist, p.originY + dy * tailDist);
    pctx.lineTo(p.originX + dx * p.headDist, p.originY + dy * p.headDist);
    pctx.stroke();
  }
  pctx.globalAlpha = 1;
}

// --- Hero video loop-seam mask ---
// The clip is a fixed loop; instead of a visible jump-cut, bloom to white
// over its last ~3s and fade that white back out over the first ~0.6s of
// the next loop, so the restart reads as an intentional "glows so bright
// it burns up and refreshes" beat rather than a glitch.
const portraitFade = document.getElementById("portrait-fade");
const FADE_IN_SECONDS = 3;
const FADE_OUT_SECONDS = 0.6;
// Glitch window straddles the exact loop point — brief and subtle, timed
// so it mostly overlaps the moment the picture is already whited out.
const GLITCH_PRE_SECONDS = 0.45;
const GLITCH_POST_SECONDS = 0.3;
let wasGlitching = false;
let lastFrameTime = null;
function updatePortraitFade(timestamp) {
  const dt = lastFrameTime == null ? 0 : Math.min(0.1, (timestamp - lastFrameTime) / 1000);
  lastFrameTime = timestamp;

  if (portraitVideo && portraitFade && portraitVideo.duration) {
    const t = portraitVideo.currentTime;
    const dur = portraitVideo.duration;
    const tailStart = dur - FADE_IN_SECONDS;
    let opacity = 0;
    if (t >= tailStart) {
      opacity = Math.min(1, Math.max(0, (t - tailStart) / FADE_IN_SECONDS));
    } else if (t <= FADE_OUT_SECONDS) {
      opacity = Math.min(1, Math.max(0, 1 - t / FADE_OUT_SECONDS));
    }
    portraitFade.style.opacity = opacity.toFixed(3);

    const nearLoopPoint = dur - t <= GLITCH_PRE_SECONDS || t <= GLITCH_POST_SECONDS;
    appEl?.classList.toggle("glitching", nearLoopPoint);

    // Rising edge only — spawn/vibrate once per glitch, not every frame.
    if (nearLoopPoint && !wasGlitching) {
      spawnGlitchParticles();
      haptic([25, 20, 35]);
    }
    wasGlitching = nearLoopPoint;
  }

  updateAndDrawParticles(dt);
  requestAnimationFrame(updatePortraitFade);
}

buildUI();
setOctave(state.octave);
resizeParticleCanvas();
requestAnimationFrame(animateLeds);
requestAnimationFrame(updatePortraitFade);
