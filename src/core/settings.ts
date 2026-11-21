/**
 * Пользовательские настройки (ТЗ 3.8): чувствительность мыши, громкость,
 * вибрация, качество теней, индикатор шума. Хранятся в localStorage.
 */
export type ShadowQuality = 'off' | 'low' | 'high';

export interface Settings {
  mouseSensitivity: number; // множитель 0.2..3
  volume: number; // 0..1
  shake: boolean;
  haptics: boolean;
  shadows: ShadowQuality;
  noiseMeter: boolean;
  /** Высота кадра в пикселях для PSX-рендера; 0 — родное разрешение (PSX-эффекты выкл). */
  renderHeight: number;
  /** Сила дрожания вершин 0..1. */
  jitter: number;
  /** Сила «плавания» текстур (аффинные UV) 0..1. */
  affine: number;
}

const KEY = 'dinoscare.settings';
const BASE_SENS = 0.0022;

export const DEFAULT_SETTINGS: Settings = {
  mouseSensitivity: 1,
  volume: 0.8,
  shake: true,
  haptics: true,
  shadows: 'low',
  noiseMeter: true,
  renderHeight: 270,
  jitter: 0.5,
  affine: 0.4,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* повреждённые данные — используем значения по умолчанию */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* не критично */
  }
}

/** Радиан на пиксель мыши. */
export function radiansPerPixel(s: Settings): number {
  return BASE_SENS * s.mouseSensitivity;
}
