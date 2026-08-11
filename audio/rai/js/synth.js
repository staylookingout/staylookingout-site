// RAI — Voice Engine
// Hybrid synthesis: robotic oscillator source -> 3-band parallel formant
// filter (vowel morph) -> character/resonance stage -> delay.
// Mirrors the design spec's DSP architecture, implemented with the Web Audio API.

// Approximate average adult-vowel formants (F1, F2, F3 in Hz), ordered
// low->high along the pad's Y axis: u, o, a, e, i.
const VOWELS = [
  { label: "U", f: [300, 870, 2240] },
  { label: "O", f: [570, 840, 2410] },
  { label: "A", f: [730, 1090, 2440] },
  { label: "E", f: [530, 1840, 2480] },
  { label: "I", f: [270, 2290, 3010] },
];

const FORMANT_GAIN = [1, 0.6, 0.35];
const FORMANT_Q = [12, 14, 16];

function lerp(a, b, t) { return a + (b - a) * t; }

/** Interpolate formant frequencies + a readable vowel label from y in [0,1]. */
function vowelAt(y) {
  const t = Math.min(0.999999, Math.max(0, y)) * (VOWELS.length - 1);
  const i = Math.floor(t);
  const frac = t - i;
  const a = VOWELS[i];
  const b = VOWELS[Math.min(i + 1, VOWELS.length - 1)];
  const f = a.f.map((v, idx) => lerp(v, b.f[idx], frac));
  const label = frac < 0.5 ? a.label : b.label;
  return { f, label };
}

function freqForMidiNote(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

function makeSaturationCurve(amount = 12) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export class VoiceEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.isSounding = false;
    this.currentFreq = 220;
    this.glideTime = 0.05;
    this.voiceScale = 1;
    this.formantSpread = 1;
    this.currentVowelY = 0.5;
    this.vowelLabel = "A";

    // --- Oscillator source (blended, "robotic" base) ---
    this.oscSaw = ctx.createOscillator();
    this.oscSaw.type = "sawtooth";
    this.oscSquare = ctx.createOscillator();
    this.oscSquare.type = "square";
    this.gainSaw = ctx.createGain();
    this.gainSaw.gain.value = 0.7;
    this.gainSquare = ctx.createGain();
    this.gainSquare.gain.value = 0.28;
    this.oscSaw.connect(this.gainSaw);
    this.oscSquare.connect(this.gainSquare);
    this.oscBus = ctx.createGain();
    this.oscBus.gain.value = 1;
    this.gainSaw.connect(this.oscBus);
    this.gainSquare.connect(this.oscBus);

    // --- Vibrato LFO ---
    this.vibLfo = ctx.createOscillator();
    this.vibLfo.type = "sine";
    this.vibLfo.frequency.value = 5.5;
    this.vibGain = ctx.createGain();
    this.vibGain.gain.value = 0;
    this.vibLfo.connect(this.vibGain);
    this.vibGain.connect(this.oscSaw.frequency);
    this.vibGain.connect(this.oscSquare.frequency);

    // --- 3-band parallel formant filter ---
    this.formantBus = ctx.createGain();
    this.formants = FORMANT_GAIN.map((gain, idx) => {
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.Q.value = FORMANT_Q[idx];
      const g = ctx.createGain();
      g.gain.value = gain;
      this.oscBus.connect(filter);
      filter.connect(g);
      g.connect(this.formantBus);
      return filter;
    });

    // --- Character / resonance stage ---
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeSaturationCurve(6);
    this.shaper.oversample = "2x";
    this.charFilter = ctx.createBiquadFilter();
    this.charFilter.type = "lowpass";
    this.charFilter.frequency.value = 5200;
    this.charFilter.Q.value = 0.7;
    this.formantBus.connect(this.shaper);
    this.shaper.connect(this.charFilter);

    // --- Amplitude envelope (monophonic gate) ---
    this.ampEnv = ctx.createGain();
    this.ampEnv.gain.value = 0;
    this.charFilter.connect(this.ampEnv);

    // --- Delay ---
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.28;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = 0.32;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 0.25;
    this.dry = ctx.createGain();
    this.dry.gain.value = 1;

    this.ampEnv.connect(this.dry);
    this.ampEnv.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.delayWet);

    this.out = ctx.createGain();
    this.out.gain.value = 0.85;
    this.dry.connect(this.out);
    this.delayWet.connect(this.out);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.out.connect(this.analyser);

    this._applyVowel(this.currentVowelY, true);
  }

  connect(dest) {
    this.out.connect(dest);
  }

  start() {
    this.oscSaw.start();
    this.oscSquare.start();
    this.vibLfo.start();
  }

  /** freq in Hz, velocity 0-1 */
  noteOn(freq, velocity = 1) {
    const now = this.ctx.currentTime;
    const glide = this.isSounding ? this.glideTime : 0;
    if (glide > 0.001) {
      this.oscSaw.frequency.cancelScheduledValues(now);
      this.oscSquare.frequency.cancelScheduledValues(now);
      this.oscSaw.frequency.setTargetAtTime(freq, now, glide / 3);
      this.oscSquare.frequency.setTargetAtTime(freq, now, glide / 3);
    } else {
      this.oscSaw.frequency.setValueAtTime(freq, now);
      this.oscSquare.frequency.setValueAtTime(freq, now);
    }
    this.currentFreq = freq;
    this.ampEnv.gain.cancelScheduledValues(now);
    this.ampEnv.gain.setTargetAtTime(Math.max(0.0001, velocity), now, 0.008);
    this.isSounding = true;
  }

  noteOff() {
    const now = this.ctx.currentTime;
    this.ampEnv.gain.cancelScheduledValues(now);
    this.ampEnv.gain.setTargetAtTime(0, now, 0.05);
    this.isSounding = false;
  }

  setNoteFromMidi(n, velocity = 1) {
    this.noteOn(freqForMidiNote(n), velocity);
  }

  /** y in [0,1] — vowel morph position (Voice Pad Y axis) */
  setVowelY(y) {
    this.currentVowelY = y;
    this._applyVowel(y);
  }

  _applyVowel(y, immediate = false) {
    const { f, label } = vowelAt(y);
    this.vowelLabel = label;
    const now = this.ctx.currentTime;
    // Spread widens/narrows the formant bands around their common center
    // (Formant Spread knob), independent of the Voice knob's overall
    // pitch-shift of the whole formant set.
    const mean = (f[0] + f[1] + f[2]) / 3;
    this.formants.forEach((filter, idx) => {
      const spread = mean + (f[idx] - mean) * this.formantSpread;
      const target = spread * this.voiceScale;
      if (immediate) filter.frequency.setValueAtTime(target, now);
      else filter.frequency.setTargetAtTime(target, now, 0.02);
    });
  }

  /** seconds */
  setGlideTime(seconds) {
    this.glideTime = seconds;
  }

  /** 0-1 */
  setDelayMix(amount) {
    const now = this.ctx.currentTime;
    this.delayWet.gain.setTargetAtTime(amount * 0.7, now, 0.02);
    this.feedback.gain.setTargetAtTime(0.15 + amount * 0.35, now, 0.02);
  }

  /** -1 (baritone) .. 0 (neutral) .. 1 (soprano) */
  setVoiceCharacter(v) {
    this.voiceScale = 1 + v * 0.35;
    this._applyVowel(this.currentVowelY);
  }

  /** 0.5 (narrow/robotic) .. 1 (natural) .. 1.8 (wide/alien) */
  setFormantSpread(v) {
    this.formantSpread = v;
    this._applyVowel(this.currentVowelY);
  }

  /** 0-1 */
  setVibratoDepth(v) {
    this.vibGain.gain.setTargetAtTime(v * 9, this.ctx.currentTime, 0.02);
  }

  /** returns 0-1 RMS-ish level, for the LED voicebox display */
  getLevel() {
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }
}

export { freqForMidiNote, vowelAt };
