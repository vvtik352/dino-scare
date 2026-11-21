import * as THREE from 'three';
import { Rng } from '../utils/rng';
import type { MaterialKind } from './materials';

/**
 * Процедурные текстуры в духе PS1: 64×64, NearestFilter, без мип-карт.
 * Рисуются на canvas при первом запросе (вне браузера — недоступны, возвращается null).
 *
 * tile — сколько метров мира покрывает одна копия текстуры (UV у геометрии в метрах).
 * local — UV считаются от угла объекта (ящик/окно рисуется целиком, а не «обрезком» мирового узора).
 */
export interface TextureSpec {
  tile: [number, number];
  local: boolean;
  draw: (g: Painter) => void;
}

const SIZE = 64;

/** Тонкая обёртка над ImageData: пиксельное рисование с шумом. */
export class Painter {
  readonly w: number;
  readonly h: number;
  private data: Uint8ClampedArray;

  constructor(readonly img: ImageData, readonly rng: Rng) {
    this.w = img.width;
    this.h = img.height;
    this.data = img.data;
  }

  set(x: number, y: number, c: number, mul = 1): void {
    const xi = ((Math.floor(x) % this.w) + this.w) % this.w;
    const yi = ((Math.floor(y) % this.h) + this.h) % this.h;
    const i = (yi * this.w + xi) * 4;
    this.data[i] = Math.min(255, ((c >> 16) & 255) * mul);
    this.data[i + 1] = Math.min(255, ((c >> 8) & 255) * mul);
    this.data[i + 2] = Math.min(255, (c & 255) * mul);
    this.data[i + 3] = 255;
  }

  /** Умножить яркость пикселя. */
  shade(x: number, y: number, mul: number): void {
    const xi = ((Math.floor(x) % this.w) + this.w) % this.w;
    const yi = ((Math.floor(y) % this.h) + this.h) % this.h;
    const i = (yi * this.w + xi) * 4;
    this.data[i] = Math.min(255, (this.data[i] as number) * mul);
    this.data[i + 1] = Math.min(255, (this.data[i + 1] as number) * mul);
    this.data[i + 2] = Math.min(255, (this.data[i + 2] as number) * mul);
  }

  fill(c: number, noise = 0): void {
    this.rect(0, 0, this.w, this.h, c, noise);
  }

  rect(x0: number, y0: number, w: number, h: number, c: number, noise = 0): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) this.set(x, y, c, 1 + (this.rng.next() - 0.5) * 2 * noise);
    }
  }

  /** Пятна: случайные затемнения/осветления кругами. */
  blotches(count: number, rMin: number, rMax: number, mulMin: number, mulMax: number): void {
    for (let i = 0; i < count; i++) {
      const cx = this.rng.range(0, this.w);
      const cy = this.rng.range(0, this.h);
      const r = this.rng.range(rMin, rMax);
      const m = this.rng.range(mulMin, mulMax);
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const d = Math.hypot(x, y) / r;
          if (d <= 1) this.shade(cx + x, cy + y, 1 + (m - 1) * (1 - d));
        }
      }
    }
  }

  /** Вертикальные потёки (грязь под окнами, ржавчина). */
  streaks(count: number, mul: number, minLen = 8, maxLen = 40): void {
    for (let i = 0; i < count; i++) {
      const x = this.rng.int(0, this.w - 1);
      const y0 = this.rng.int(0, this.h - 1);
      const len = this.rng.int(minLen, maxLen);
      for (let y = 0; y < len; y++) this.shade(x, y0 + y, 1 + (mul - 1) * (1 - y / len));
    }
  }

  frame(x0: number, y0: number, w: number, h: number, t: number, c: number, noise = 0): void {
    this.rect(x0, y0, w, t, c, noise);
    this.rect(x0, y0 + h - t, w, t, c, noise);
    this.rect(x0, y0, t, h, c, noise);
    this.rect(x0 + w - t, y0, t, h, c, noise);
  }
}

// ---------------------------------------------------------------------------

function bricks(base: number, mortar: number): (g: Painter) => void {
  return (g) => {
    g.fill(mortar, 0.08);
    const rowH = 8;
    const brickW = 16;
    for (let row = 0; row < g.h / rowH; row++) {
      const off = row % 2 ? brickW / 2 : 0;
      for (let col = -1; col < g.w / brickW + 1; col++) {
        const tint = g.rng.range(0.8, 1.15);
        const x0 = col * brickW + off;
        for (let y = row * rowH + 1; y < row * rowH + rowH; y++) {
          for (let x = x0 + 1; x < x0 + brickW; x++) g.set(x, y, base, tint * (1 + (g.rng.next() - 0.5) * 0.18));
        }
      }
    }
    g.blotches(5, 4, 12, 0.75, 0.95);
    g.streaks(10, 0.8);
  };
}

function plaster(base: number): (g: Painter) => void {
  return (g) => {
    g.fill(base, 0.1);
    g.blotches(10, 3, 14, 0.8, 1.08);
    // Швы панелей.
    for (let x = 0; x < g.w; x++) g.shade(x, g.h - 1, 0.7);
    for (let y = 0; y < g.h; y++) g.shade(g.w - 1, y, 0.75);
    g.streaks(14, 0.75, 10, 50);
  };
}

function planks(base: number, plankH: number, vertical = false): (g: Painter) => void {
  return (g) => {
    const n = Math.floor((vertical ? g.w : g.h) / plankH);
    for (let i = 0; i < n; i++) {
      const tint = g.rng.range(0.82, 1.12);
      for (let a = 0; a < (vertical ? g.h : g.w); a++) {
        for (let b = 0; b < plankH; b++) {
          const grain = 1 + Math.sin((a + i * 13) * 0.4 + b * 1.7) * 0.05 + (g.rng.next() - 0.5) * 0.12;
          const edge = b === 0 ? 0.6 : 1;
          if (vertical) g.set(i * plankH + b, a, base, tint * grain * edge);
          else g.set(a, i * plankH + b, base, tint * grain * edge);
        }
      }
    }
  };
}

function window(glass: number, frame: number, lit: boolean): (g: Painter) => void {
  return (g) => {
    if (lit) {
      // Тёплое свечение: ярче к центру, с силуэтом штор по краям.
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const d = Math.hypot((x - g.w / 2) / g.w, (y - g.h / 2) / g.h);
          g.set(x, y, glass, (1.1 - d * 0.9) * (1 + (g.rng.next() - 0.5) * 0.08));
        }
      }
      g.rect(3, 3, 9, g.h - 6, 0x6a3a1a, 0.1);
      g.rect(g.w - 12, 3, 9, g.h - 6, 0x6a3a1a, 0.1);
    } else {
      g.fill(glass, 0.06);
      // Блик на стекле.
      for (let i = 0; i < 26; i++) {
        g.shade(10 + i, 50 - i, 1.6);
        g.shade(11 + i, 50 - i, 1.4);
      }
    }
    g.frame(0, 0, g.w, g.h, 3, frame, 0.1);
    g.rect(g.w / 2 - 1, 0, 3, g.h, frame, 0.1);
    g.rect(0, g.h / 2 - 1, g.w, 3, frame, 0.1);
  };
}

export const TEXTURES: Partial<Record<MaterialKind, TextureSpec>> = {
  wall: { tile: [2, 2], local: false, draw: bricks(0x8a5a44, 0x5a524a) },
  plaster: { tile: [3, 3], local: false, draw: plaster(0x8a8478) },
  boundary: { tile: [4, 4], local: false, draw: plaster(0x55565a) },
  road: {
    tile: [4, 4], local: false,
    draw: (g) => {
      g.fill(0x34343a, 0.22);
      g.blotches(14, 2, 10, 0.75, 1.1);
      for (let i = 0; i < 120; i++) g.shade(g.rng.int(0, 63), g.rng.int(0, 63), g.rng.range(1.3, 1.7));
      // Трещина.
      let x = g.rng.int(0, 63);
      for (let y = 0; y < g.h; y++) {
        x += g.rng.int(-1, 1);
        g.shade(x, y, 0.55);
      }
    },
  },
  sidewalk: {
    tile: [2, 2], local: false,
    draw: (g) => {
      g.fill(0x6e6e6a, 0.12);
      for (const [x0, y0] of [[0, 0], [32, 0], [0, 32], [32, 32]] as const) {
        g.rect(x0 + 1, y0 + 1, 30, 30, 0x6e6e6a, 0.12);
        if (g.rng.chance(0.6)) g.blotches(1, 4, 9, 0.8, 0.9);
      }
      for (let i = 0; i < g.w; i++) {
        g.shade(i, 0, 0.6);
        g.shade(i, 32, 0.6);
        g.shade(0, i, 0.6);
        g.shade(32, i, 0.6);
      }
    },
  },
  ground: { tile: [4, 4], local: false, draw: (g) => { g.fill(0x3d3a2e, 0.25); g.blotches(12, 3, 10, 0.7, 1.15); } },
  floor: { tile: [2, 2], local: false, draw: planks(0x6a4e36, 8) },
  roof: {
    tile: [4, 4], local: false,
    draw: (g) => {
      g.fill(0x3e3e44, 0.3);
      g.blotches(10, 4, 14, 0.75, 1.1);
      for (let i = 0; i < 200; i++) g.shade(g.rng.int(0, 63), g.rng.int(0, 63), g.rng.range(0.6, 1.5));
    },
  },
  stairs: { tile: [1.2, 1.2], local: true, draw: planks(0x7a5e3a, 8, true) },
  crate: {
    tile: [1, 1], local: true,
    draw: (g) => {
      planks(0x8a6a3e, 8)(g);
      g.frame(0, 0, 64, 64, 6, 0x5e4426, 0.12);
      for (let i = 4; i < 60; i++) {
        for (let t = -2; t <= 2; t++) g.set(i, i + t, 0x5e4426, 1 + (g.rng.next() - 0.5) * 0.2);
      }
    },
  },
  container: {
    tile: [1.2, 2.6], local: true,
    draw: (g) => {
      for (let x = 0; x < g.w; x++) {
        const ridge = 0.8 + 0.3 * Math.sin((x / 64) * Math.PI * 2 * 5);
        for (let y = 0; y < g.h; y++) g.set(x, y, 0x2f5f7f, ridge * (1 + (g.rng.next() - 0.5) * 0.12));
      }
      g.streaks(18, 0.6, 6, 30);
      g.blotches(6, 2, 6, 0.6, 0.85);
    },
  },
  dumpster: {
    tile: [1, 1.2], local: true,
    draw: (g) => {
      g.fill(0x2f5a36, 0.14);
      g.rect(0, 0, 64, 8, 0x1e2a20, 0.1);
      g.blotches(8, 2, 7, 0.55, 0.85);
      g.streaks(10, 0.7);
    },
  },
  ac: {
    tile: [0.9, 0.55], local: true,
    draw: (g) => {
      g.fill(0x9aa2a8, 0.1);
      const cx = 40, cy = 32, r = 22;
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d < r) g.set(x, y, 0x3a3e42, (y % 4 < 2 ? 0.7 : 1.1));
        }
      }
      for (let y = 8; y < 56; y += 4) g.rect(4, y, 12, 1, 0x5a6066);
      g.frame(0, 0, 64, 64, 2, 0x6a7076);
      g.streaks(8, 0.75, 4, 20);
    },
  },
  door: {
    tile: [1, 1], local: true,
    draw: (g) => {
      planks(0x6e3a26, 8, true)(g);
      g.frame(6, 4, 52, 24, 2, 0x4a2618);
      g.frame(6, 34, 52, 26, 2, 0x4a2618);
      g.rect(50, 30, 4, 4, 0xb8a060);
    },
  },
  manhole: {
    tile: [0.9, 0.9], local: true,
    draw: (g) => {
      g.fill(0x28302a, 0.15);
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const d = Math.hypot(x - 32, y - 32);
          if (d > 29) g.set(x, y, 0x1a1e1a);
          else if ((x + y) % 8 < 2 || (x - y + 64) % 8 < 2) g.shade(x, y, 0.65);
          if (Math.abs(d - 28) < 1.5) g.shade(x, y, 1.4);
        }
      }
    },
  },
  lampPost: { tile: [0.5, 2], local: true, draw: (g) => { g.fill(0x3a3a3a, 0.2); g.streaks(10, 0.6); } },
  windowLit: { tile: [1.2, 1.3], local: true, draw: window(0xffc070, 0x3a3028, true) },
  windowDark: { tile: [1.2, 1.3], local: true, draw: window(0x18202c, 0x3a3830, false) },
  dino: {
    tile: [1, 1], local: true,
    draw: (g) => {
      g.fill(0x56702e, 0.15);
      // Чешуя: сетка из ромбов + тёмные полосы по спине.
      for (let y = 0; y < g.h; y++) {
        for (let x = 0; x < g.w; x++) {
          const s = ((x + (Math.floor(y / 4) % 2) * 2) % 4 === 0 || y % 4 === 0) ? 0.78 : 1;
          g.shade(x, y, s);
        }
      }
      for (let i = 0; i < 6; i++) {
        const y0 = i * 11 + g.rng.int(0, 4);
        for (let x = 0; x < g.w; x++) for (let t = 0; t < 3; t++) g.shade(x, y0 + t + Math.round(Math.sin(x * 0.2) * 2), 0.6);
      }
      g.blotches(8, 3, 8, 0.7, 1.15);
    },
  },
};

const cache = new Map<MaterialKind, THREE.Texture>();

/** Текстура для материала (null — если для вида текстуры нет или нет DOM). */
export function getTexture(kind: MaterialKind): THREE.Texture | null {
  const spec = TEXTURES[kind];
  if (!spec || typeof document === 'undefined') return null;
  let tex = cache.get(kind);
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(SIZE, SIZE);
  spec.draw(new Painter(img, new Rng(0x9e3779b9 ^ kind.length * 7919 ^ kind.charCodeAt(0))));
  ctx.putImageData(img, 0, 0);

  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(1 / spec.tile[0], 1 / spec.tile[1]);
  cache.set(kind, tex);
  return tex;
}

export function usesLocalUv(kind: MaterialKind): boolean {
  return TEXTURES[kind]?.local ?? false;
}
