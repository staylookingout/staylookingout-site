// RAI — One-octave on-screen keyboard (mouse / touch / QWERTY)
// Always available, no MIDI hardware required.

const WHITE_STEPS = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B (semitones)
const BLACK_LAYOUT = [
  { after: 0, semitone: 1, key: "W" },  // C#
  { after: 1, semitone: 3, key: "E" },  // D#
  { after: 3, semitone: 6, key: "T" },  // F#
  { after: 4, semitone: 8, key: "Y" },  // G#
  { after: 5, semitone: 10, key: "U" }, // A#
];
const WHITE_KEYS_QWERTY = ["A", "S", "D", "F", "G", "H", "J"];

export function buildKeyboard(container, { onNoteOn, onNoteOff, getOctave }) {
  container.innerHTML = "";
  const whiteEls = [];
  const keyElBySemitone = {};

  WHITE_STEPS.forEach((semitone, idx) => {
    const el = document.createElement("div");
    el.className = "key white";
    el.dataset.semitone = String(semitone);
    el.dataset.qwerty = WHITE_KEYS_QWERTY[idx];
    container.appendChild(el);
    whiteEls.push(el);
    keyElBySemitone[semitone] = el;
  });

  BLACK_LAYOUT.forEach((b) => {
    const el = document.createElement("div");
    el.className = "key black";
    el.dataset.semitone = String(b.semitone);
    el.dataset.qwerty = b.key;
    const leftPct = ((b.after + 1) / WHITE_STEPS.length) * 100;
    el.style.left = `calc(${leftPct}% - 3.1%)`;
    container.appendChild(el);
    keyElBySemitone[b.semitone] = el;
  });

  const active = new Map(); // semitone -> pointerId or "kb"

  function noteNumber(semitone) {
    const octave = getOctave();
    return (octave + 1) * 12 + semitone;
  }

  function press(semitone, source) {
    if (active.has(semitone)) return;
    active.set(semitone, source);
    const el = keyElBySemitone[semitone];
    el?.classList.add("active");
    try {
      navigator.vibrate?.(12); // short tap feedback; no-op where unsupported
    } catch {
      /* ignore */
    }
    onNoteOn(noteNumber(semitone), 0.9);
  }

  function release(semitone, source) {
    if (active.get(semitone) !== source && source !== "any") return;
    active.delete(semitone);
    const el = keyElBySemitone[semitone];
    el?.classList.remove("active");
    onNoteOff(noteNumber(semitone));
  }

  function releaseAll() {
    for (const semitone of Array.from(active.keys())) release(semitone, "any");
  }

  // Pointer (mouse/touch) interaction
  container.querySelectorAll(".key").forEach((el) => {
    const semitone = Number(el.dataset.semitone);
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      press(semitone, e.pointerId);
    });
    el.addEventListener("pointerup", (e) => release(semitone, e.pointerId));
    el.addEventListener("pointercancel", (e) => release(semitone, e.pointerId));
    el.addEventListener("pointerleave", (e) => {
      if (e.buttons === 0) release(semitone, e.pointerId);
    });
  });

  // QWERTY interaction
  const semitoneByQwerty = {};
  container.querySelectorAll(".key").forEach((el) => {
    semitoneByQwerty[el.dataset.qwerty] = Number(el.dataset.semitone);
  });
  const heldKeys = new Set();
  function onKeyDown(e) {
    const k = e.key.toUpperCase();
    if (k in semitoneByQwerty && !heldKeys.has(k)) {
      heldKeys.add(k);
      press(semitoneByQwerty[k], "kb:" + k);
    }
  }
  function onKeyUp(e) {
    const k = e.key.toUpperCase();
    if (k in semitoneByQwerty) {
      heldKeys.delete(k);
      release(semitoneByQwerty[k], "kb:" + k);
    }
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);

  return {
    /** External note-on highlight (e.g. from a connected MIDI controller) */
    highlightExternal(midiNote, on) {
      const octave = getOctave();
      const semitone = midiNote - (octave + 1) * 12;
      const el = keyElBySemitone[semitone];
      if (!el) return;
      el.classList.toggle("active", on);
    },
    releaseAll,
  };
}
