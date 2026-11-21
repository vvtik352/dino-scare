import type { CityLayout, Rect, Vec2 } from '../world/layout';

/**
 * Навигационная сетка для крупного существа (упрощённый вариант из ТЗ 3.3:
 * «A* по сетке + локальный steering» вместо NavMesh).
 *
 * Препятствия расширяются на радиус тела, поэтому T-Rex физически не может
 * зайти в узкие переулки (2–3 м) и здания — это и есть укрытия игрока.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  /** 1 = непроходимо. */
  readonly blocked: Uint8Array;

  constructor(
    readonly bounds: Rect,
    readonly cellSize: number,
    blockers: readonly Rect[],
    readonly agentRadius: number,
  ) {
    this.cols = Math.ceil((bounds.x1 - bounds.x0) / cellSize);
    this.rows = Math.ceil((bounds.z1 - bounds.z0) / cellSize);
    this.blocked = new Uint8Array(this.cols * this.rows);

    // Края карты.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const p = this.cellCenter(c, r);
        if (
          p.x - bounds.x0 < agentRadius || bounds.x1 - p.x < agentRadius ||
          p.z - bounds.z0 < agentRadius || bounds.z1 - p.z < agentRadius
        ) {
          this.blocked[r * this.cols + c] = 1;
        }
      }
    }
    for (const b of blockers) this.blockRect(b, agentRadius);
  }

  static fromLayout(layout: CityLayout, agentRadius: number, cellSize = 1): NavGrid {
    return new NavGrid(layout.bounds, cellSize, layout.navBlockers, agentRadius);
  }

  index(c: number, r: number): number {
    return r * this.cols + c;
  }

  cellOf(x: number, z: number): { c: number; r: number } {
    return {
      c: Math.floor((x - this.bounds.x0) / this.cellSize),
      r: Math.floor((z - this.bounds.z0) / this.cellSize),
    };
  }

  cellCenter(c: number, r: number): Vec2 {
    return {
      x: this.bounds.x0 + (c + 0.5) * this.cellSize,
      z: this.bounds.z0 + (r + 0.5) * this.cellSize,
    };
  }

  inside(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  isFree(c: number, r: number): boolean {
    return this.inside(c, r) && this.blocked[this.index(c, r)] === 0;
  }

  isFreeAt(x: number, z: number): boolean {
    const { c, r } = this.cellOf(x, z);
    return this.isFree(c, r);
  }

  /** Ближайшая свободная клетка (поиск по расширяющимся квадратам). */
  nearestFree(x: number, z: number, maxRadius = 30): Vec2 | null {
    const { c, r } = this.cellOf(x, z);
    if (this.isFree(c, r)) return this.cellCenter(c, r);
    let best: Vec2 | null = null;
    let bestD = Infinity;
    for (let rad = 1; rad <= maxRadius; rad++) {
      for (let dc = -rad; dc <= rad; dc++) {
        for (let dr = -rad; dr <= rad; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          if (!this.isFree(c + dc, r + dr)) continue;
          const p = this.cellCenter(c + dc, r + dr);
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Прямая проходимость отрезка (для сглаживания пути и steering). */
  segmentFree(a: Vec2, b: Vec2): boolean {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(dist / (this.cellSize * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isFreeAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
    }
    return true;
  }

  /**
   * A* (8 направлений, без срезания углов). Возвращает сглаженный путь
   * от start до goal (goal заменяется ближайшей свободной клеткой), или null.
   */
  findPath(start: Vec2, goal: Vec2): Vec2[] | null {
    const s0 = this.nearestFree(start.x, start.z, 6);
    const g0 = this.nearestFree(goal.x, goal.z);
    if (!s0 || !g0) return null;
    const sc = this.cellOf(s0.x, s0.z);
    const gc = this.cellOf(g0.x, g0.z);
    const startIdx = this.index(sc.c, sc.r);
    const goalIdx = this.index(gc.c, gc.r);
    if (startIdx === goalIdx) return [g0];

    const n = this.cols * this.rows;
    const gScore = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    gScore[startIdx] = 0;
    heap.push(startIdx, this.heuristic(sc.c, sc.r, gc.c, gc.r));

    const SQRT2 = Math.SQRT2;
    let found = false;
    let expanded = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === goalIdx) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expanded > 60000) break;
      const cc = cur % this.cols;
      const cr = (cur - cc) / this.cols;
      const gCur = gScore[cur] as number;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dc === 0 && dr === 0) continue;
          const nc = cc + dc;
          const nr = cr + dr;
          if (!this.isFree(nc, nr)) continue;
          // Без срезания углов по диагонали.
          if (dc !== 0 && dr !== 0 && (!this.isFree(cc + dc, cr) || !this.isFree(cc, cr + dr))) continue;
          const ni = this.index(nc, nr);
          if (closed[ni]) continue;
          const tentative = gCur + (dc !== 0 && dr !== 0 ? SQRT2 : 1);
          if (tentative < (gScore[ni] as number)) {
            gScore[ni] = tentative;
            came[ni] = cur;
            heap.push(ni, tentative + this.heuristic(nc, nr, gc.c, gc.r));
          }
        }
      }
    }
    if (!found) return null;

    const cells: Vec2[] = [];
    for (let i = goalIdx; i !== -1; i = came[i] as number) {
      const c = i % this.cols;
      cells.push(this.cellCenter(c, (i - c) / this.cols));
    }
    cells.reverse();
    return this.smooth(cells);
  }

  /** Убираем лишние точки: оставляем только те, между которыми нет прямой видимости. */
  private smooth(path: Vec2[]): Vec2[] {
    if (path.length <= 2) return path.slice(1);
    const out: Vec2[] = [];
    let anchor = path[0] as Vec2;
    let i = 1;
    while (i < path.length) {
      let j = i;
      while (j + 1 < path.length && this.segmentFree(anchor, path[j + 1] as Vec2)) j++;
      out.push(path[j] as Vec2);
      anchor = path[j] as Vec2;
      i = j + 1;
    }
    return out;
  }

  private heuristic(c: number, r: number, gc: number, gr: number): number {
    const dx = Math.abs(c - gc);
    const dz = Math.abs(r - gr);
    return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
  }

  private blockRect(rect: Rect, inflate: number): void {
    const a = this.cellOf(rect.x0 - inflate, rect.z0 - inflate);
    const b = this.cellOf(rect.x1 + inflate, rect.z1 + inflate);
    for (let r = Math.max(0, a.r); r <= Math.min(this.rows - 1, b.r); r++) {
      for (let c = Math.max(0, a.c); c <= Math.min(this.cols - 1, b.c); c++) {
        // Клетка блокируется, если её центр в пределах inflate от прямоугольника.
        const p = this.cellCenter(c, r);
        const dx = Math.max(rect.x0 - p.x, 0, p.x - rect.x1);
        const dz = Math.max(rect.z0 - p.z, 0, p.z - rect.z1);
        if (dx * dx + dz * dz < inflate * inflate) this.blocked[this.index(c, r)] = 1;
      }
    }
  }
}

/** Бинарная куча по приоритету (для A*). */
class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    this.items.push(item);
    this.prio.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.prio[p] as number) <= priority) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0] as number;
    const lastItem = this.items.pop() as number;
    const lastPrio = this.prio.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.prio[0] = lastPrio;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && (this.prio[l] as number) < (this.prio[m] as number)) m = l;
        if (r < n && (this.prio[r] as number) < (this.prio[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a] as number;
    this.items[a] = this.items[b] as number;
    this.items[b] = ti;
    const tp = this.prio[a] as number;
    this.prio[a] = this.prio[b] as number;
    this.prio[b] = tp;
  }
}
