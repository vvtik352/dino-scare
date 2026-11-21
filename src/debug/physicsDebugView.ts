import * as THREE from 'three';
import type { Physics } from '../core/physics';

/** Каркасная отрисовка всех коллайдеров Rapier (отладка). */
export class PhysicsDebugView {
  private lines: THREE.LineSegments;
  private geometry = new THREE.BufferGeometry();
  visible = false;

  constructor(private readonly physics: Physics, scene: THREE.Scene) {
    const material = new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.6 });
    this.lines = new THREE.LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.lines.visible = v;
  }

  update(): void {
    if (!this.visible) return;
    const { vertices } = this.physics.world.debugRender();
    // Копируем: буфер Rapier живёт в памяти WASM и может быть переиспользован.
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    this.geometry.computeBoundingSphere();
  }
}
