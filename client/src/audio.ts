/**
 * Procedural audio system using Web Audio API.
 * Generates retro-style SFX without external assets.
 * Supports volume control and mute toggle.
 */

type SfxName =
  | "tower_place"
  | "tower_sell"
  | "tower_upgrade"
  | "shoot_arrow"
  | "shoot_cannon"
  | "shoot_frost"
  | "shoot_lightning"
  | "shoot_mortar"
  | "enemy_hit"
  | "enemy_die"
  | "boss_die"
  | "wave_start"
  | "wave_complete"
  | "attack_incoming"
  | "game_over"
  | "victory"
  | "ui_click";

/** Minimum ms between plays of the same SFX (prevents spam) */
const THROTTLE_MS: Partial<Record<SfxName, number>> = {
  shoot_arrow: 80,
  shoot_cannon: 120,
  shoot_frost: 100,
  shoot_lightning: 100,
  shoot_mortar: 150,
  enemy_hit: 50,
  enemy_die: 40,
};

class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private _volume = 0.3;
  private _muted = false;
  private lastPlayed = new Map<SfxName, number>();

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) {
      this.masterGain.gain.value = this._muted ? 0 : this._volume;
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(m: boolean) {
    this._muted = m;
    if (this.masterGain) {
      this.masterGain.gain.value = m ? 0 : this._volume;
    }
  }

  toggleMute(): boolean {
    this.muted = !this._muted;
    return this._muted;
  }

  private ensureCtx(): { ctx: AudioContext; master: GainNode } | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this._muted ? 0 : this._volume;
        this.masterGain.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return { ctx: this.ctx, master: this.masterGain! };
  }

  play(name: SfxName): void {
    const audio = this.ensureCtx();
    if (!audio) return;
    const { ctx, master } = audio;

    // Throttle rapid-fire sounds
    const throttle = THROTTLE_MS[name];
    if (throttle) {
      const now = performance.now();
      const last = this.lastPlayed.get(name) ?? 0;
      if (now - last < throttle) return;
      this.lastPlayed.set(name, now);
    }

    switch (name) {
      case "tower_place":
        this.playTone(ctx, master, 440, 0.08, "square", 0.4);
        this.playTone(ctx, master, 660, 0.08, "square", 0.3, 0.08);
        break;

      case "tower_sell":
        this.playTone(ctx, master, 550, 0.1, "sawtooth", 0.3);
        this.playTone(ctx, master, 330, 0.12, "sawtooth", 0.25, 0.08);
        break;

      case "tower_upgrade":
        this.playTone(ctx, master, 440, 0.06, "square", 0.35);
        this.playTone(ctx, master, 554, 0.06, "square", 0.35, 0.06);
        this.playTone(ctx, master, 660, 0.1, "square", 0.4, 0.12);
        break;

      case "shoot_arrow":
        this.playNoise(ctx, master, 0.04, 800, 0.15);
        break;

      case "shoot_cannon":
        this.playNoise(ctx, master, 0.12, 200, 0.35);
        this.playTone(ctx, master, 80, 0.15, "sine", 0.4);
        break;

      case "shoot_frost":
        this.playNoise(ctx, master, 0.08, 2000, 0.12);
        this.playTone(ctx, master, 1200, 0.1, "sine", 0.15);
        break;

      case "shoot_lightning":
        this.playNoise(ctx, master, 0.06, 3000, 0.2);
        this.playTone(ctx, master, 1800, 0.04, "sawtooth", 0.2);
        this.playNoise(ctx, master, 0.04, 4000, 0.15, 0.06);
        break;

      case "shoot_mortar":
        this.playTone(ctx, master, 60, 0.2, "sine", 0.4);
        this.playNoise(ctx, master, 0.15, 150, 0.3, 0.05);
        break;

      case "enemy_hit":
        this.playTone(ctx, master, 200, 0.04, "square", 0.15);
        break;

      case "enemy_die":
        this.playNoise(ctx, master, 0.08, 600, 0.2);
        this.playTone(ctx, master, 300, 0.06, "square", 0.2);
        this.playTone(ctx, master, 150, 0.08, "square", 0.15, 0.04);
        break;

      case "boss_die":
        this.playNoise(ctx, master, 0.3, 300, 0.4);
        this.playTone(ctx, master, 100, 0.3, "sawtooth", 0.35);
        this.playTone(ctx, master, 50, 0.4, "sine", 0.3, 0.15);
        break;

      case "wave_start":
        this.playTone(ctx, master, 330, 0.15, "square", 0.3);
        this.playTone(ctx, master, 440, 0.15, "square", 0.3, 0.15);
        this.playTone(ctx, master, 554, 0.2, "square", 0.35, 0.3);
        break;

      case "wave_complete":
        this.playTone(ctx, master, 523, 0.1, "square", 0.3);
        this.playTone(ctx, master, 659, 0.1, "square", 0.3, 0.1);
        this.playTone(ctx, master, 784, 0.15, "square", 0.35, 0.2);
        this.playTone(ctx, master, 1047, 0.25, "square", 0.3, 0.35);
        break;

      case "attack_incoming":
        for (let i = 0; i < 3; i++) {
          this.playTone(ctx, master, 300, 0.08, "sawtooth", 0.3, i * 0.12);
          this.playTone(ctx, master, 200, 0.08, "sawtooth", 0.25, i * 0.12 + 0.06);
        }
        break;

      case "game_over":
        this.playTone(ctx, master, 440, 0.2, "sawtooth", 0.35);
        this.playTone(ctx, master, 370, 0.2, "sawtooth", 0.3, 0.2);
        this.playTone(ctx, master, 330, 0.3, "sawtooth", 0.25, 0.4);
        this.playTone(ctx, master, 262, 0.5, "sawtooth", 0.3, 0.6);
        break;

      case "victory":
        const notes = [523, 587, 659, 784, 1047];
        notes.forEach((freq, i) => {
          this.playTone(ctx, master, freq, 0.15, "square", 0.3, i * 0.12);
        });
        break;

      case "ui_click":
        this.playTone(ctx, master, 800, 0.03, "square", 0.15);
        break;
    }
  }

  private playTone(
    ctx: AudioContext,
    dest: AudioNode,
    freq: number,
    duration: number,
    type: OscillatorType,
    vol: number,
    delay = 0,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration + 0.01);
  }

  private playNoise(
    ctx: AudioContext,
    dest: AudioNode,
    duration: number,
    filterFreq: number,
    vol: number,
    delay = 0,
  ): void {
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    source.start(ctx.currentTime + delay);
    source.stop(ctx.currentTime + delay + duration + 0.01);
  }
}

/** Singleton audio manager */
export const audio = new AudioManager();
export type { SfxName };
