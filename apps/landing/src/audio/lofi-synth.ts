// Lo-fi Vinyl & Chords Generator via Web Audio API
export class LoFiPlayer {
  private ctx: AudioContext | null = null;
  private isPlaying = false;
  private timerId: number | null = null;
  private noiseNode: AudioNode | null = null;
  private masterGain: GainNode | null = null;

  // Chill chord progression in Fmaj9 -> Dm9 -> Gm9 -> C13
  private chords = [
    [174.61, 220.00, 261.63, 329.63, 392.00], // Fmaj9 (F3, A3, C4, E4, G4)
    [146.83, 174.61, 220.00, 261.63, 329.63], // Dm9   (D3, F3, A3, C4, E4)
    [196.00, 233.08, 293.66, 349.23, 440.00], // Gm9   (G3, Bb3, D4, F4, A4)
    [130.81, 196.00, 246.94, 329.63, 440.00]  // C13   (C3, G3, B3, E4, A4)
  ];
  private currentChordIndex = 0;

  public toggle(): boolean {
    if (this.isPlaying) {
      this.stop();
      return false;
    } else {
      this.start();
      return true;
    }
  }

  public start() {
    if (this.isPlaying) return;
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    if (!this.ctx) {
      this.ctx = new AudioContextClass();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.18, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    this.startVinylCrackle();
    this.playChordSequence();

    this.isPlaying = true;
  }

  public stop() {
    if (!this.isPlaying) return;
    if (this.timerId) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.noiseNode) {
      try {
        (this.noiseNode as AudioBufferSourceNode).stop();
      } catch {
        // The source may already have stopped.
      }
      this.noiseNode.disconnect();
      this.noiseNode = null;
    }
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 0.5);
    }
    this.isPlaying = false;
  }

  private startVinylCrackle() {
    if (!this.ctx || !this.masterGain) return;

    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      // Soft pink noise with occasional pop/crackle
      const r = Math.random() * 2 - 1;
      const isPop = Math.random() < 0.0008;
      output[i] = (r * 0.04) + (isPop ? (Math.random() * 0.5 - 0.25) : 0);
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;
    whiteNoise.loop = true;

    // Filter to warm vinyl frequencies
    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1200;
    bandpass.Q.value = 0.8;

    const crackleGain = this.ctx.createGain();
    crackleGain.gain.value = 0.12;

    whiteNoise.connect(bandpass);
    bandpass.connect(crackleGain);
    crackleGain.connect(this.masterGain);

    whiteNoise.start();
    this.noiseNode = whiteNoise;
  }

  private playChordSequence = () => {
    if (!this.isPlaying && this.timerId !== null) return;
    if (!this.ctx || !this.masterGain) return;

    const chord = this.chords[this.currentChordIndex];
    this.currentChordIndex = (this.currentChordIndex + 1) % this.chords.length;

    const now = this.ctx.currentTime;
    const chordDuration = 3.2;

    chord.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      // Warm mellow vintage Rhodes / electric piano tone
      osc.type = idx === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);

      // Subtle detune for lo-fi tape flutter
      osc.detune.setValueAtTime((Math.random() - 0.5) * 8, now);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(650 + idx * 80, now);
      filter.frequency.exponentialRampToValueAtTime(320, now + chordDuration);

      // Soft ADSR envelope
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.07 / chord.length, now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + chordDuration);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);

      osc.start(now);
      osc.stop(now + chordDuration + 0.1);
    });

    this.timerId = window.setTimeout(this.playChordSequence, (chordDuration - 0.2) * 1000);
  };
}
