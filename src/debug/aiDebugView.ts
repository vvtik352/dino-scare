import * as THREE from 'three';
import type { Dinosaur } from '../entities/dinosaur';
import type { NavGrid } from '../ai/navGrid';
import { DEFAULT_VISION, HEARING_MAX_RANGE } from '../ai/senses';

/**
 * Отладочная визуализация AI (ТЗ п.4): навигационная сетка, конус зрения,
 * радиусы слышимости, текущий путь и последняя известная позиция игрока.
 */
export class AiDebugView {
  readonly navMesh: THREE.Mesh;
  private senses = new THREE.Group();
  private visionCone: THREE.Mesh;
  private hearingRings: THREE.LineLoop[] = [];
  private pathLine: THREE.Line;
  private lastKnownMarker: THREE.Mesh;

  constructor(nav: NavGrid, scene: THREE.Scene) {
    // --- Сетка: заблокированные клетки — красный полупрозрачный слой ---
    const positions: number[] = [];
    const s = nav.cellSize;
    for (let r = 0; r < nav.rows; r++) {
      for (let c = 0; c < nav.cols; c++) {
        if (nav.isFree(c, r)) continue;
        const p = nav.cellCenter(c, r);
        const x0 = p.x - s / 2, x1 = p.x + s / 2, z0 = p.z - s / 2, z1 = p.z + s / 2;
        const y = 0.25;
        positions.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.navMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xff2020, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.navMesh.visible = false;
    scene.add(this.navMesh);

    // --- Конус зрения (плоский сектор) ---
    const half = THREE.MathUtils.degToRad(DEFAULT_VISION.fovDeg / 2);
    const coneGeom = new THREE.CircleGeometry(DEFAULT_VISION.range, 24, Math.PI / 2 - half, half * 2);
    coneGeom.rotateX(-Math.PI / 2);
    this.visionCone = new THREE.Mesh(coneGeom, new THREE.MeshBasicMaterial({
      color: 0xffee00, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.visionCone.position.y = 0.3;
    this.senses.add(this.visionCone);

    // --- Радиусы слуха для громкостей шагов ---
    const levels: Array<[number, number]> = [[0.1, 0x55ff55], [0.3, 0xffff55], [0.6, 0xff9955], [0.8, 0xff5555]];
    for (const [loud, color] of levels) {
      const pts: THREE.Vector3[] = [];
      const radius = loud * HEARING_MAX_RANGE;
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, 0.35, Math.sin(a) * radius));
      }
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, fog: false, transparent: true, opacity: 0.7 }),
      );
      this.hearingRings.push(ring);
      this.senses.add(ring);
    }

    // --- Путь ---
    this.pathLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x00ffff, fog: false, depthTest: false }),
    );
    this.pathLine.frustumCulled = false;
    this.pathLine.renderOrder = 998;
    this.lastKnownMarker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.5),
      new THREE.MeshBasicMaterial({ color: 0xff00ff, fog: false, depthTest: false }),
    );
    this.lastKnownMarker.renderOrder = 998;
    this.senses.visible = false;
    scene.add(this.senses, this.pathLine, this.lastKnownMarker);
    this.pathLine.visible = false;
    this.lastKnownMarker.visible = false;
  }

  setNavVisible(v: boolean): void {
    this.navMesh.visible = v;
  }

  setSensesVisible(v: boolean): void {
    this.senses.visible = v;
    this.pathLine.visible = v;
  }

  update(dino: Dinosaur): void {
    if (!this.senses.visible) {
      this.lastKnownMarker.visible = false;
      return;
    }
    this.senses.position.set(dino.position.x, 0, dino.position.z);
    this.visionCone.rotation.y = dino.heading - Math.PI / 2;
    this.visionCone.position.set(Math.sin(dino.heading) * 3.5, 0.3, Math.cos(dino.heading) * 3.5);

    const pts = [new THREE.Vector3(dino.position.x, 0.5, dino.position.z)];
    for (const p of dino.path) pts.push(new THREE.Vector3(p.x, 0.5, p.z));
    this.pathLine.geometry.dispose();
    this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);

    if (dino.lastKnown) {
      this.lastKnownMarker.visible = true;
      this.lastKnownMarker.position.set(dino.lastKnown.x, dino.lastKnown.y + 1, dino.lastKnown.z);
      this.lastKnownMarker.rotation.y += 0.05;
    } else {
      this.lastKnownMarker.visible = false;
    }
  }
}
