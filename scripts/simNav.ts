import { NavGrid } from '../src/ai/navGrid';
import { Rng } from '../src/utils/rng';
import { generateCity } from '../src/world/cityGenerator';
const layout = generateCity(new Rng(0x1234).fork('city'));
const nav = NavGrid.fromLayout(layout, 2.2);
let free = 0; for (const v of nav.blocked) if (!v) free++;
console.log('grid', nav.cols, 'x', nav.rows, 'free', (free / nav.blocked.length * 100).toFixed(1) + '%');
const t0 = performance.now();
let ok = 0, fail = 0;
const rng = new Rng(7);
for (let i = 0; i < 50; i++) {
  const a = rng.pick(layout.streetNodes), b = rng.pick(layout.streetNodes);
  const p = nav.findPath(a, b);
  if (p) ok++; else fail++;
}
console.log('paths ok', ok, 'fail', fail, 'avg ms', ((performance.now() - t0) / 50).toFixed(2));
// ASCII map (каждая 2-я клетка)
const rows: string[] = [];
for (let r = 0; r < nav.rows; r += 3) { let s = ''; for (let c = 0; c < nav.cols; c += 2) s += nav.isFree(c, r) ? '.' : '#'; rows.push(s); }
console.log(rows.join('\n'));
