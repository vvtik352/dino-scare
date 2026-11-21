import type { Settings, ShadowQuality } from '../core/settings';
import { el } from './hud';

/**
 * Стартовое меню / пауза / экран смерти (ТЗ 3.8).
 * Меню — только DOM; о действиях сообщает колбэками, игрой не управляет напрямую.
 */
export interface MenuCallbacks {
  onPlay(): void;
  onNewSeed(seedText: string): void;
  onSettingsChanged(s: Settings): void;
  onRestart(): void;
}

export type MenuMode = 'start' | 'pause' | 'dead' | 'hidden';

export class Menu {
  private root: HTMLDivElement;
  private title: HTMLHeadingElement;
  private subtitle: HTMLParagraphElement;
  private playBtn: HTMLButtonElement;
  private restartBtn: HTMLButtonElement;
  private seedInput: HTMLInputElement;
  private seedRow: HTMLDivElement;
  private settingsBox: HTMLDivElement;
  mode: MenuMode = 'start';

  constructor(
    private readonly settings: Settings,
    seedText: string,
    private readonly cb: MenuCallbacks,
  ) {
    this.root = el('div', 'menu');
    const box = el('div', 'menu__box');
    this.title = el('h1');
    this.subtitle = el('p', 'menu__subtitle');

    this.playBtn = button('Играть', () => cb.onPlay());
    this.restartBtn = button('Заново', () => cb.onRestart());

    // --- Seed ---
    this.seedRow = el('div', 'menu__row');
    const seedLabel = el('label');
    seedLabel.textContent = 'Seed города';
    this.seedInput = el('input');
    this.seedInput.type = 'text';
    this.seedInput.value = seedText;
    this.seedInput.spellcheck = false;
    const applySeed = button('Создать', () => {
      const v = this.seedInput.value.trim();
      if (v) cb.onNewSeed(v);
    });
    const randomSeed = button('🎲', () => {
      this.seedInput.value = Math.floor(Math.random() * 0xffffffff).toString(36);
    });
    randomSeed.title = 'Случайный seed';
    this.seedInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') applySeed.click();
    });
    this.seedRow.append(seedLabel, this.seedInput, randomSeed, applySeed);

    // --- Настройки ---
    this.settingsBox = el('div', 'menu__settings');
    this.settingsBox.append(
      this.slider('Чувствительность мыши', 0.2, 3, 0.05, () => this.settings.mouseSensitivity, (v) => (this.settings.mouseSensitivity = v)),
      this.slider('Громкость', 0, 1, 0.01, () => this.settings.volume, (v) => (this.settings.volume = v)),
      this.checkbox('Тряска камеры', () => this.settings.shake, (v) => (this.settings.shake = v)),
      this.checkbox('Вибрация (геймпад/телефон)', () => this.settings.haptics, (v) => (this.settings.haptics = v)),
      this.checkbox('Индикатор шума', () => this.settings.noiseMeter, (v) => (this.settings.noiseMeter = v)),
      this.select('Тени', [['off', 'выкл'], ['low', 'низкие'], ['high', 'высокие']], () => this.settings.shadows, (v) => (this.settings.shadows = v as ShadowQuality)),
      this.select(
        'Разрешение (PSX)',
        [['240', '240p — грубо'], ['270', '270p'], ['360', '360p — чётче'], ['480', '480p'], ['0', 'родное (без PSX)']],
        () => String(this.settings.renderHeight),
        (v) => (this.settings.renderHeight = Number(v)),
      ),
      this.slider('Дрожание вершин', 0, 1, 0.05, () => this.settings.jitter, (v) => (this.settings.jitter = v)),
      this.slider('Плавание текстур', 0, 1, 0.05, () => this.settings.affine, (v) => (this.settings.affine = v)),
    );

    const controls = el('p', 'menu__controls');
    controls.textContent =
      'WASD — ходьба · Shift — бег · Ctrl/C — присед · Space — прыжок/залезть\n' +
      'E — дверь · F — фонарик · Esc — пауза\n' +
      'Прячься. Шум привлекает его. Почувствуй, когда он рядом.';

    const buttons = el('div', 'menu__buttons');
    buttons.append(this.playBtn, this.restartBtn);
    box.append(this.title, this.subtitle, buttons, this.seedRow, this.settingsBox, controls);
    this.root.appendChild(box);
    document.body.appendChild(this.root);

    // Клики по меню не должны «проваливаться» в canvas.
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.setMode('start');
  }

  setLoading(text: string): void {
    this.title.textContent = 'DinoScare';
    this.subtitle.textContent = text;
    this.playBtn.disabled = true;
  }

  setReady(): void {
    this.playBtn.disabled = false;
    this.setMode(this.mode);
  }

  setMode(mode: MenuMode, extra = ''): void {
    this.mode = mode;
    this.root.classList.toggle('hidden', mode === 'hidden');
    this.root.classList.toggle('menu--dead', mode === 'dead');
    switch (mode) {
      case 'start':
        this.title.textContent = 'DinoScare';
        this.subtitle.textContent = 'Где-то в городе бродит T-Rex.';
        this.playBtn.textContent = 'Играть';
        this.playBtn.style.display = '';
        this.restartBtn.style.display = 'none';
        this.seedRow.style.display = '';
        this.settingsBox.style.display = '';
        break;
      case 'pause':
        this.title.textContent = 'Пауза';
        this.subtitle.textContent = extra;
        this.playBtn.textContent = 'Продолжить';
        this.playBtn.style.display = '';
        this.restartBtn.style.display = '';
        this.seedRow.style.display = '';
        this.settingsBox.style.display = '';
        break;
      case 'dead':
        this.title.textContent = 'Тебя съели';
        this.subtitle.textContent = extra;
        this.playBtn.style.display = 'none';
        this.restartBtn.style.display = '';
        this.seedRow.style.display = 'none';
        this.settingsBox.style.display = 'none';
        break;
      case 'hidden':
        break;
    }
  }

  private changed(): void {
    this.cb.onSettingsChanged(this.settings);
  }

  private slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): HTMLElement {
    const row = el('div', 'menu__row');
    const l = el('label');
    l.textContent = label;
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    const val = el('span', 'menu__value');
    val.textContent = get().toFixed(2);
    input.addEventListener('input', () => {
      set(Number(input.value));
      val.textContent = Number(input.value).toFixed(2);
      this.changed();
    });
    row.append(l, input, val);
    return row;
  }

  private checkbox(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const row = el('div', 'menu__row');
    const l = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => {
      set(input.checked);
      this.changed();
    });
    l.append(input, document.createTextNode(' ' + label));
    row.append(l);
    return row;
  }

  private select(label: string, options: Array<[string, string]>, get: () => string, set: (v: string) => void): HTMLElement {
    const row = el('div', 'menu__row');
    const l = el('label');
    l.textContent = label;
    const s = el('select');
    for (const [value, text] of options) {
      const o = el('option');
      o.value = value;
      o.textContent = text;
      s.appendChild(o);
    }
    s.value = get();
    s.addEventListener('change', () => {
      set(s.value);
      this.changed();
    });
    row.append(l, s);
    return row;
  }
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button');
  b.textContent = text;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
