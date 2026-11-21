import * as THREE from 'three';

type V3 = readonly [number, number, number];

export interface BoxGeometryOptions {
  /** UV от угла бокса (ящик/окно рисуется целиком), иначе — мировые координаты (тайлинг). */
  local?: boolean;
  /**
   * Максимальный размер ячейки грани (м). Большие грани режутся на сетку:
   * аффинные UV в PSX-стиле на огромных полигонах «плывут» слишком сильно —
   * как и на настоящей PS1, геометрию приходится подразбивать.
   */
  cell?: number;
}

/**
 * Накопитель осевых боксов в один BufferGeometry.
 * UV задаются в метрах (проекция координат на плоскость грани).
 */
export class BoxGeometryBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private indices: number[] = [];
  private readonly local: boolean;
  private readonly cell: number;

  constructor(opts: BoxGeometryOptions = {}) {
    this.local = opts.local ?? false;
    this.cell = opts.cell ?? Infinity;
  }

  get isEmpty(): boolean {
    return this.positions.length === 0;
  }

  addBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const o: V3 = this.local ? [x0, y0, z0] : [0, 0, 0];
    this.face([x1, y0, z1], [x1, y0, z0], [x1, y1, z1], [1, 0, 0], o);
    this.face([x0, y0, z0], [x0, y0, z1], [x0, y1, z0], [-1, 0, 0], o);
    this.face([x0, y1, z1], [x1, y1, z1], [x0, y1, z0], [0, 1, 0], o);
    this.face([x0, y0, z0], [x1, y0, z0], [x0, y0, z1], [0, -1, 0], o);
    this.face([x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [0, 0, 1], o);
    this.face([x1, y0, z0], [x0, y0, z0], [x1, y1, z0], [0, 0, -1], o);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.indices);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /**
   * Грань: угол a, соседние углы b (ось U) и d (ось V), обход a→b→c→d против часовой
   * при взгляде снаружи. Режется на nu×nv ячеек.
   */
  private face(a: V3, b: V3, d: V3, n: V3, origin: V3): void {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]] as const;
    const nu = Math.max(1, Math.ceil(Math.hypot(...u) / this.cell));
    const nv = Math.max(1, Math.ceil(Math.hypot(...v) / this.cell));
    const base = this.positions.length / 3;
    const horizontal = Math.abs(n[1]) > 0.5;
    const facesX = Math.abs(n[0]) > 0.5;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const s = i / nu;
        const t = j / nv;
        const px = a[0] + u[0] * s + v[0] * t;
        const py = a[1] + u[1] * s + v[1] * t;
        const pz = a[2] + u[2] * s + v[2] * t;
        this.positions.push(px, py, pz);
        this.normals.push(n[0], n[1], n[2]);
        const lx = px - origin[0], ly = py - origin[1], lz = pz - origin[2];
        if (horizontal) this.uvs.push(lx, lz);
        else if (facesX) this.uvs.push(lz, ly);
        else this.uvs.push(lx, ly);
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p = base + j * row + i;
        this.indices.push(p, p + 1, p + row + 1, p, p + row + 1, p + row);
      }
    }
  }
}
