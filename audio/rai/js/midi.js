// RAI — Web MIDI handling
// Mirrors the original Delay Lama MIDI implementation spec:
//   Note        -> pitch
//   Pitch bend  -> vowel (high-resolution)
//   CC1         -> vibrato
//   CC5         -> glide/portamento time
//   CC7         -> voice volume
//   CC12        -> delay mix
//   CC13        -> voice character (timbre)

export class MidiManager {
  constructor(handlers) {
    this.handlers = handlers; // { onNoteOn, onNoteOff, onPitchBend, onCC }
    this.access = null;
    this.inputs = [];
  }

  get supported() {
    return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
  }

  async connect() {
    if (!this.supported) return { supported: false };
    try {
      this.access = await navigator.requestMIDIAccess();
      this._bindInputs();
      this.access.onstatechange = () => this._bindInputs();
      return { supported: true, deviceCount: this.inputs.length };
    } catch (err) {
      return { supported: true, error: err };
    }
  }

  _bindInputs() {
    this.inputs = [];
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this._handleMessage(e);
      this.inputs.push(input);
    }
  }

  _handleMessage(e) {
    const [status, d1, d2] = e.data;
    const command = status & 0xf0;

    switch (command) {
      case 0x90: // note on
        if (d2 > 0) this.handlers.onNoteOn?.(d1, d2 / 127);
        else this.handlers.onNoteOff?.(d1);
        break;
      case 0x80: // note off
        this.handlers.onNoteOff?.(d1);
        break;
      case 0xe0: { // pitch bend, 14-bit, high-res
        const value = ((d2 << 7) | d1) - 8192; // -8192..8191
        this.handlers.onPitchBend?.(value / 8192); // -1..1
        break;
      }
      case 0xb0: // control change
        this.handlers.onCC?.(d1, d2 / 127);
        break;
      default:
        break;
    }
  }

  get deviceNames() {
    return this.inputs.map((i) => i.name);
  }
}
