/** Small synthesized court sounds; no asset bundle or audio dependency needed. */
export class CourtSfx {
  constructor() {
    this.ctx = null;
    this.noise = null;
    const unlock = () => this.unlock();
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('pointerdown', unlock, { passive: true });
  }

  unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.ctx ??= new AudioCtx();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.noise) {
      this.noise = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * 0.32), this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
  }

  tone(freq, duration, gain, type = 'sine', endFreq = freq * 0.7) {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const now = c.currentTime;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    amp.gain.setValueAtTime(Math.max(0.0001, gain), now);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(c.destination);
    osc.start(now); osc.stop(now + duration);
  }

  noiseHit(duration, gain, frequency, q = 0.8) {
    const c = this.ctx;
    if (!c || c.state !== 'running' || !this.noise) return;
    const now = c.currentTime;
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();
    src.buffer = this.noise;
    filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q;
    amp.gain.setValueAtTime(Math.max(0.0001, gain), now);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(amp).connect(c.destination);
    src.start(now); src.stop(now + duration);
  }

  dribble(impact = 3) {
    const k = Math.min(1, impact / 7);
    this.tone(105, 0.075, 0.025 + k * 0.035, 'sine', 48);
    this.noiseHit(0.035, 0.012 + k * 0.012, 620, 0.65);
  }

  rim(speed = 4) {
    const k = Math.min(1, speed / 8);
    this.tone(910, 0.16, 0.025 + k * 0.045, 'triangle', 690);
    this.tone(1370, 0.10, 0.012 + k * 0.022, 'sine', 1010);
  }

  board(speed = 5) {
    const k = Math.min(1, speed / 9);
    this.noiseHit(0.12, 0.035 + k * 0.055, 420, 0.55);
    this.tone(155, 0.10, 0.018 + k * 0.02, 'square', 92);
  }

  swish(clean = true) {
    // Two short filtered layers read as cord sliding around a ball rather than
    // a single generic noise burst. The clean make gets the longest tail.
    this.noiseHit(clean ? 0.30 : 0.23, clean ? 0.12 : 0.085, 3150, 0.48);
    this.noiseHit(clean ? 0.22 : 0.17, clean ? 0.064 : 0.048, 1750, 0.72);
    this.tone(clean ? 570 : 430, 0.14, clean ? 0.026 : 0.021, 'sine', 245);
  }

  perfect() {
    this.tone(760, 0.16, 0.035, 'sine', 1040);
    this.tone(1140, 0.22, 0.025, 'sine', 1520);
  }

  dunk() {
    this.tone(68, 0.18, 0.09, 'sine', 36);
    this.noiseHit(0.09, 0.075, 190, 0.62);
    this.rim(9);
  }
}
