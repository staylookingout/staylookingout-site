// RAI — Knob + Voice Pad + LED voicebox UI helpers

/** Vertical-drag knob. Calls onChange(value) with value in [min,max]. */
export function makeKnob(el, { onChange }) {
  const min = parseFloat(el.dataset.min);
  const max = parseFloat(el.dataset.max);
  let value = parseFloat(el.dataset.value);

  function angleFor(v) {
    const t = (v - min) / (max - min);
    return -130 + t * 260; // degrees
  }
  function render() {
    el.style.setProperty("--angle", `${angleFor(value)}deg`);
  }
  function setValue(v, notify = true) {
    value = Math.min(max, Math.max(min, v));
    render();
    if (notify) onChange(value);
  }

  let dragStartY = null;
  let dragStartValue = value;
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    dragStartY = e.clientY;
    dragStartValue = value;
  });
  el.addEventListener("pointermove", (e) => {
    if (dragStartY === null) return;
    const dy = dragStartY - e.clientY;
    const range = max - min;
    setValue(dragStartValue + (dy / 140) * range);
  });
  function endDrag() { dragStartY = null; }
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const range = max - min;
      setValue(value - Math.sign(e.deltaY) * range * 0.02);
    },
    { passive: false }
  );

  // Render the initial visual state immediately, but don't fire onChange
  // yet — the audio engine may not exist at page-load time. Callers sync
  // the engine to this initial value once it's created (see main.js).
  render();
  return { setValue, getValue: () => value };
}

/** XY Voice Pad. onMove(x,y) in [0,1]; onEngage()/onRelease() gate the note. */
export function makeVoicePad(el, cursorEl, { onMove, onEngage, onRelease }) {
  let active = false;

  function posFromEvent(e) {
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x, y: 1 - y }; // invert so up = higher on Y axis
  }

  function moveCursor(x, y) {
    cursorEl.style.left = `${x * 100}%`;
    cursorEl.style.top = `${(1 - y) * 100}%`;
  }

  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    active = true;
    el.classList.add("active");
    const { x, y } = posFromEvent(e);
    moveCursor(x, y);
    onMove(x, y);
    onEngage();
  });
  el.addEventListener("pointermove", (e) => {
    if (!active) return;
    const { x, y } = posFromEvent(e);
    moveCursor(x, y);
    onMove(x, y);
  });
  function end(e) {
    if (!active) return;
    active = false;
    el.classList.remove("active");
    onRelease();
  }
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

/**
 * Radial white-glow "voice bloom" — four arms (up/down/left/right) of
 * segments radiating out from a center point, brightness/reach driven by
 * live level. Fully transparent background (screen-blended onto the
 * portrait beneath). At rest (level ~0, driven by a gentle breathing
 * envelope from the caller) it pulses softly rather than sitting flat.
 */
const ARMS = [
  { dx: 0, dy: -1 }, // up
  { dx: 0, dy: 1 },  // down
  { dx: -1, dy: 0 }, // left
  { dx: 1, dy: 0 },  // right
];

export function drawLedBars(canvas, level, seedPhase = 0) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const segCount = 9;
  const maxReach = Math.min(w, h) / 2 - 6;
  const spacing = maxReach / segCount;
  const clampedLevel = Math.min(1, Math.max(0, level));

  ARMS.forEach((arm, armIdx) => {
    const wobble = Math.sin(seedPhase * (1.2 + armIdx * 0.35) + armIdx * 1.7) * 0.12;
    const armLevel = Math.min(1, Math.max(0, clampedLevel * (1 + wobble)));
    const litSegs = armLevel * segCount;

    for (let s = 0; s < segCount; s++) {
      const dist = (s + 1) * spacing;
      const x = cx + arm.dx * dist;
      const y = cy + arm.dy * dist;
      const reach = Math.min(1, Math.max(0, litSegs - s));
      if (reach <= 0.02) continue;

      const radius = 2.6 - s * 0.12;
      const alpha = reach * (1 - s / (segCount * 1.6));
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, alpha).toFixed(3)})`;
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 4 + armLevel * 14;
      ctx.arc(x, y, Math.max(0.6, radius), 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // Center glow — the source the bloom breathes/pulses from.
  const centerGlow = 0.55 + clampedLevel * 0.45;
  ctx.beginPath();
  ctx.fillStyle = `rgba(255,255,255,${centerGlow.toFixed(3)})`;
  ctx.shadowColor = "#ffffff";
  ctx.shadowBlur = 10 + clampedLevel * 22;
  ctx.arc(cx, cy, 2.5 + clampedLevel * 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
}
