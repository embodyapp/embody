// Coastline FM: an original, looped 92 BPM instrumental, synthesized only after a user click.
const BPM = 92;
const STEP = 60 / BPM / 4;
const progression = [
  { bass: 41, chord: [57, 60, 64, 67], lead: [72, 76, 79, 76] }, // Fmaj9
  { bass: 38, chord: [57, 60, 64, 69], lead: [72, 69, 76, 72] }, // Dm9
  { bass: 43, chord: [58, 62, 65, 69], lead: [74, 77, 81, 77] }, // Gm9
  { bass: 36, chord: [58, 64, 67, 69], lead: [76, 74, 72, 67] }, // C13
];
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class LoFiPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: number | null = null;
  private step = 0;
  private nextTime = 0;
  private playing = false;

  toggle(): boolean {
    if (this.playing) { this.stop(); return false; }
    return this.start();
  }

  private start(): boolean {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return false;
    this.ctx ??= new AudioContextClass();
    void this.ctx.resume();
    const ctx = this.ctx;
    const master = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 5500;
    tone.connect(master);
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.38, ctx.currentTime + 0.12);
    master.connect(ctx.destination);
    this.master = master;
    this.output = tone;
    this.noise ??= this.createNoise(ctx);
    this.step = 0;
    this.nextTime = ctx.currentTime + 0.07;
    this.playing = true;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 25);
    return true;
  }

  private output: AudioNode | null = null;

  stop() {
    if (!this.playing || !this.ctx || !this.master) return;
    this.playing = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const master = this.master;
    master.gain.cancelScheduledValues(this.ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, this.ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.16);
    window.setTimeout(() => master.disconnect(), 400);
    this.master = null;
    this.output = null;
  }

  private createNoise(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private note(midi: number, time: number, length: number, volume: number, type: OscillatorType, cutoff: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz(midi), time);
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(volume, time + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + length);
    osc.connect(filter).connect(gain).connect(this.output!);
    osc.start(time);
    osc.stop(time + length + 0.02);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); gain.disconnect(); };
  }

  private drum(time: number, kind: 'kick' | 'snare' | 'hat', volume = 1) {
    const ctx = this.ctx!;
    if (kind === 'kick') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(145, time);
      osc.frequency.exponentialRampToValueAtTime(46, time + 0.11);
      gain.gain.setValueAtTime(0.001, time);
      gain.gain.exponentialRampToValueAtTime(0.55 * volume, time + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.23);
      osc.connect(gain).connect(this.output!);
      osc.start(time); osc.stop(time + 0.24);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = kind === 'hat' ? 'highpass' : 'bandpass';
    filter.frequency.value = kind === 'hat' ? 6800 : 1600;
    const gain = ctx.createGain();
    const length = kind === 'hat' ? 0.045 : 0.15;
    gain.gain.setValueAtTime(0.13 * volume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + length);
    source.connect(filter).connect(gain).connect(this.output!);
    source.start(time); source.stop(time + length);
    source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  }

  private schedule() {
    if (!this.ctx || !this.playing) return;
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      const bar = Math.floor(this.step / 16) % 4;
      const phrase = Math.floor(this.step / 64) % 2;
      const beat = this.step % 16;
      const chord = progression[bar];
      const time = this.nextTime;
      if (beat === 0 || beat === 10) this.drum(time, 'kick', beat === 0 ? 1 : 0.72);
      if (beat === 4 || beat === 12) this.drum(time, 'snare', 0.9);
      if (phrase === 1 && bar === 3 && beat === 15) this.drum(time, 'snare', 0.28);
      if (beat % 2 === 0) this.drum(time + (beat % 4 === 2 ? 0.022 : 0), 'hat', beat % 4 === 0 ? 0.62 : 0.36);
      if ([0, 3, 6, 8, 11, 14].includes(beat)) {
        const offset = beat === 6 || beat === 14 ? 7 : beat === 11 ? 12 : 0;
        this.note(chord.bass + offset, time, STEP * 2.5, 0.22, 'triangle', 380);
      }
      if (beat === 0 || beat === 7 || beat === 12) {
        chord.chord.forEach((pitch, index) => this.note(pitch, time + index * 0.012, STEP * (beat === 0 ? 10 : 4), 0.052, 'sine', 1600));
      }
      if ([2, 6, 9, 14].includes(beat)) {
        const index = [2, 6, 9, 14].indexOf(beat);
        const pitch = phrase === 1 && index === 3 ? chord.lead[index] + 12 : chord.lead[index];
        this.note(pitch, time, STEP * (index === 3 ? 1.8 : 2.7), 0.06, 'sine', 2400);
      }
      this.step++;
      this.nextTime += STEP;
    }
  }
}
