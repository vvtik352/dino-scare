import * as THREE from 'three';
import type { Input } from '../core/input';

/**
 * Отладочная noclip-камера: свободный полёт сквозь геометрию.
 * WASD — движение, Space/C — вверх/вниз, Shift — быстрее.
 */
export class FlyCamera {
  yaw = 0;
  pitch = 0;
  readonly position = new THREE.Vector3();
  sensitivity = 0.0022;
  speed = 12;

  constructor(private readonly input: Input) {}

  /** Синхронизироваться с текущей камерой (чтобы не было рывка при включении). */
  syncFrom(camera: THREE.Camera): void {
    this.position.copy(camera.position);
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  update(dt: number, camera: THREE.Camera): void {
    const { dx, dy } = this.input.takeMouseDelta();
    this.yaw -= dx * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * this.sensitivity, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    const i = this.input;
    if (i.isDown('KeyW')) move.add(forward);
    if (i.isDown('KeyS')) move.sub(forward);
    if (i.isDown('KeyD')) move.add(right);
    if (i.isDown('KeyA')) move.sub(right);
    if (i.isDown('Space')) move.y += 1;
    if (i.isDown('KeyC')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.speed * (i.isDown('ShiftLeft') ? 3 : 1) * dt);
      this.position.add(move);
    }

    camera.position.copy(this.position);
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
