/**
 * Минимальный HUD (ТЗ 3.8): индикатор шума, «сердцебиение»-виньетка при
 * близости динозавра, подсказка взаимодействия, прицел-точка.
 */
export class Hud {
  private root: HTMLDivElement;
  private noiseFill: HTMLDivElement;
  private noiseBox: HTMLDivElement;
  private vignette: HTMLDivElement;
  private prompt: HTMLDivElement;
  private stance: HTMLDivElement;
  private pulse = 0;

  constructor() {
    this.root = el('div', 'hud hidden');
    this.vignette = el('div', 'hud__vignette');
    const crosshair = el('div', 'hud__crosshair');
    this.prompt = el('div', 'hud__prompt');
    this.noiseBox = el('div', 'hud__noise');
    const label = el('div', 'hud__noise-label');
    label.textContent = 'ШУМ';
    const bar = el('div', 'hud__noise-bar');
    this.noiseFill = el('div', 'hud__noise-fill');
    bar.appendChild(this.noiseFill);
    this.noiseBox.append(label, bar);
    this.stance = el('div', 'hud__stance');
    this.root.append(this.vignette, crosshair, this.prompt, this.noiseBox, this.stance);
    document.body.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setNoiseMeterVisible(v: boolean): void {
    this.noiseBox.style.display = v ? '' : 'none';
  }

  /**
   * noise 0..1, danger 0..1 (близость/возбуждение динозавра),
   * shake 0..1 (текущая тряска — вспышка виньетки).
   */
  update(dt: number, noise: number, danger: number, shake: number, crouching: boolean, prompt: string | null): void {
    this.noiseFill.style.width = `${Math.round(noise * 100)}%`;
    this.noiseFill.style.background = noise > 0.6 ? '#c33' : noise > 0.25 ? '#c93' : '#7a7';

    // Пульс виньетки — частота как у сердцебиения в аудио.
    const bpm = 70 + danger * 90;
    this.pulse += dt * (bpm / 60) * Math.PI * 2;
    const beat = Math.pow(Math.max(0, Math.sin(this.pulse)), 8);
    const strength = Math.max(0, danger - 0.25) / 0.75;
    const alpha = Math.min(0.85, strength * (0.35 + 0.35 * beat) + shake * 0.4);
    this.vignette.style.opacity = alpha.toFixed(3);

    this.stance.textContent = crouching ? '▼ присед' : '';
    if (prompt) {
      this.prompt.textContent = prompt;
      this.prompt.style.opacity = '1';
    } else {
      this.prompt.style.opacity = '0';
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
