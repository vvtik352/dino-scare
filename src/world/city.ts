import * as THREE from 'three';
import type { Physics } from '../core/physics';
import { cellSizeFor, usesLocalUv, type MaterialKind, type Materials } from '../render/materials';
import { BoxGeometryBuilder } from '../render/boxGeometry';
import type { CityLayout } from './layout';
import { CHUNK_SIZE } from './constants';
import { StreetLights } from './streetLights';

/**
 * Превращает CityLayout в сцену и физику.
 *
 * Геометрия сливается в один меш на пару (чанк 32×32 м, материал):
 * мало draw calls и при этом работает frustum culling по чанкам (ТЗ 3.1).
 * Каждый коллайдер — отдельный cuboid в Rapier (BVH внутри Rapier справляется).
 */
export class City {
  readonly root = new THREE.Group();
  readonly lights: StreetLights;
  private chunkMeshes: THREE.Mesh[] = [];

  constructor(
    readonly layout: CityLayout,
    private readonly scene: THREE.Scene,
    physics: Physics,
    materials: Materials,
  ) {
    this.root.name = 'city';
    this.buildMeshes(materials);
    this.buildColliders(physics);
    scene.add(this.root);
    this.lights = new StreetLights(layout.lamps, this.root);
  }

  get meshCount(): number {
    return this.chunkMeshes.length;
  }

  update(dt: number, viewer: THREE.Vector3, time: number): void {
    this.lights.update(dt, viewer, time);
  }

  dispose(): void {
    for (const m of this.chunkMeshes) m.geometry.dispose();
    this.scene.remove(this.root);
  }

  private buildMeshes(materials: Materials): void {
    const builders = new Map<string, { mat: MaterialKind; builder: BoxGeometryBuilder }>();
    for (const b of this.layout.boxes) {
      // Чанк по центру бокса; большие боксы (дорога, границы) — в отдельную группу.
      const big = b.x1 - b.x0 > CHUNK_SIZE * 2 || b.z1 - b.z0 > CHUNK_SIZE * 2;
      const cx = big ? 'big' : Math.floor((b.x0 + b.x1) / 2 / CHUNK_SIZE);
      const cz = big ? '' : Math.floor((b.z0 + b.z1) / 2 / CHUNK_SIZE);
      const key = `${cx}:${cz}:${b.mat}`;
      let entry = builders.get(key);
      if (!entry) {
        entry = { mat: b.mat, builder: new BoxGeometryBuilder({ local: usesLocalUv(b.mat), cell: cellSizeFor(b.mat) }) };
        builders.set(key, entry);
      }
      entry.builder.addBox(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1);
    }
    for (const [key, { mat, builder }] of builders) {
      const mesh = new THREE.Mesh(builder.build(), materials.get(mat));
      mesh.name = key;
      mesh.matrixAutoUpdate = false;
      const emissive = mat === 'lampGlow' || mat === 'windowLit' || mat === 'windowDark' || mat === 'road';
      mesh.castShadow = !emissive;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.chunkMeshes.push(mesh);
    }
  }

  private buildColliders(physics: Physics): void {
    for (const b of this.layout.boxes) {
      if (!b.collide) continue;
      physics.addStaticBox(
        (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2,
        (b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2, (b.z1 - b.z0) / 2,
      );
    }
    for (const r of this.layout.ramps) physics.addStaticConvex(new Float32Array(r.points));
  }
}
