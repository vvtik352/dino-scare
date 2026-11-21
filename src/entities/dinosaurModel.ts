import * as THREE from 'three';
import type { Materials } from '../render/materials';

/**
 * Временная модель T-Rex из примитивов (ТЗ 3.3: «временный примитив с анимацией-заглушкой»).
 * Высота ~5 м, длина ~11 м. Нос смотрит в +Z локально.
 * Анимация: шаги ногами, покачивание корпуса и хвоста, открытие челюсти при рыке.
 */
export class DinosaurModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private head = new THREE.Group();
  private jaw: THREE.Mesh;
  private tail: THREE.Group[] = [];
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private phase = 0;
  private jawOpen = 0;

  constructor(materials: Materials) {
    const mat = materials.get('dino');
    const box = (w: number, h: number, d: number): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

    this.root.add(this.body);
    this.body.position.y = 3.2;

    const torso = box(1.8, 2.0, 4.2);
    torso.rotation.x = -0.12;
    this.body.add(torso);

    const neck = box(1.1, 1.4, 1.6);
    neck.position.set(0, 0.9, 2.3);
    neck.rotation.x = -0.5;
    this.body.add(neck);

    this.head.position.set(0, 1.5, 3.0);
    this.body.add(this.head);
    const skull = box(1.1, 1.0, 2.0);
    skull.position.set(0, 0.2, 0.8);
    this.head.add(skull);
    this.jaw = box(0.95, 0.35, 1.8);
    this.jaw.geometry.translate(0, 0, 0.9);
    this.jaw.position.set(0, -0.35, 0);
    this.head.add(this.jaw);

    // Короткие ручки.
    for (const s of [-1, 1]) {
      const arm = box(0.2, 0.7, 0.2);
      arm.position.set(s * 0.7, -0.4, 1.8);
      arm.rotation.x = 0.6;
      this.body.add(arm);
    }

    // Хвост из сегментов.
    let parent: THREE.Object3D = this.body;
    let z = -2.0;
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Group();
      seg.position.set(0, i === 0 ? 0.2 : 0, z);
      parent.add(seg);
      const size = 1.4 - i * 0.3;
      const len = 1.6;
      const m = box(size * 0.9, size, len);
      m.position.z = -len / 2;
      seg.add(m);
      this.tail.push(seg);
      parent = seg;
      z = -len;
    }

    // Ноги.
    for (const [leg, s] of [[this.legL, -1], [this.legR, 1]] as const) {
      leg.position.set(s * 0.8, 2.9, -0.3);
      this.root.add(leg);
      const thigh = box(0.7, 1.7, 0.9);
      thigh.position.y = -0.8;
      leg.add(thigh);
      const shin = box(0.45, 1.4, 0.5);
      shin.position.set(0, -2.1, -0.2);
      leg.add(shin);
      const foot = box(0.6, 0.25, 1.0);
      foot.position.set(0, -2.75, 0.2);
      leg.add(foot);
    }

    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
  }

  /** speed — м/с; roar — 0..1 сила рыка (открытие пасти). */
  update(dt: number, speed: number, roar: number, alertness: number): void {
    const strideFreq = 0.9 * speed / 2.2;
    this.phase += dt * strideFreq * Math.PI * 2 * 0.5;
    const swing = Math.min(speed / 6, 1) * 0.6;
    this.legL.rotation.x = Math.sin(this.phase) * swing;
    this.legR.rotation.x = -Math.sin(this.phase) * swing;
    this.body.position.y = 3.2 + Math.abs(Math.cos(this.phase)) * 0.15 * Math.min(speed / 3, 1);
    // Наклон корпуса вперёд на бегу.
    this.body.rotation.x = Math.min(speed / 10, 1) * 0.15;
    this.body.rotation.z = Math.sin(this.phase) * 0.03 * Math.min(speed / 3, 1);

    // Хвост волной.
    const t = performance.now() / 1000;
    this.tail.forEach((seg, i) => {
      seg.rotation.y = Math.sin(t * 1.3 - i * 0.6 + this.phase * 0.3) * 0.08 * (1 + i * 0.3);
      seg.rotation.x = 0.05 + i * 0.04;
    });

    // Голова: приподнята, когда насторожен; чуть опущена в погоне.
    this.head.rotation.x = THREE.MathUtils.damp(this.head.rotation.x, alertness > 0.5 ? -0.15 : 0.1, 3, dt);
    this.head.rotation.y = Math.sin(t * 0.7) * 0.15 * (1 - alertness);

    this.jawOpen = THREE.MathUtils.damp(this.jawOpen, roar, 10, dt);
    this.jaw.rotation.x = this.jawOpen * 0.7;
  }
}
