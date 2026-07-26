/**
 * Everything is synthesised — no asset pipeline, no licensing, and the pitch of
 * every plop is tunable in code. iOS Safari refuses to start an AudioContext
 * outside a user gesture, so `unlock()` is wired to the first pointer event.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(this.ctx.destination);
  }

  private get ready(): boolean {
    return this.enabled && this.ctx !== null && this.master !== null;
  }

  /** Jewel landing in a socket: a short filtered-noise thock plus a body tone. */
  plop(pitch = 1): void {
    if (!this.ready) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(120 * pitch, t + 0.09);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);

    osc.connect(gain).connect(this.master as GainNode);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  /** Jewel lifting off the board: a lighter tick that rises through the batch. */
  tick(pitch = 1): void {
    if (!this.ready) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(620 * pitch, t);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

    osc.connect(gain).connect(this.master as GainNode);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  /** A colour finished — one soft major chime, no fanfare. */
  chime(): void {
    if (!this.ready) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gain = ctx.createGain();
      const at = t + i * 0.05;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
      osc.connect(gain).connect(this.master as GainNode);
      osc.start(at);
      osc.stop(at + 0.75);
    });
  }

  /** Tap that had no legal effect. Dull, brief, not a buzzer. */
  thud(): void {
    if (!this.ready) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(gain).connect(this.master as GainNode);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  win(): void {
    if (!this.ready) return;
    const ctx = this.ctx as AudioContext;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const gain = ctx.createGain();
      const at = t + i * 0.11;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
      osc.connect(gain).connect(this.master as GainNode);
      osc.start(at);
      osc.stop(at + 1.2);
    });
  }
}
