import * as THREE from 'three';

/**
 * Обёртка над WebGLRenderer. Вся отрисовка кадра идёт через render().
 *
 * Точка расширения под PSX: свойство `pipeline`. Сейчас это прямой рендер
 * в экран; позже — рендер в низкоразрешённый target + пост-проход
 * (дизеринг, квантование палитры) без изменений в остальном коде.
 */
export interface RenderPipeline {
  setSize(width: number, height: number, pixelRatio: number): void;
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}

class DirectPipeline implements RenderPipeline {
  setSize(): void {}
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }
  dispose(): void {}
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  pipeline: RenderPipeline = new DirectPipeline();

  /** Сменить пайплайн (например, PSX ↔ прямой рендер). */
  setPipeline(p: RenderPipeline | null): void {
    if (this.pipeline === p) return;
    this.pipeline.dispose();
    this.pipeline = p ?? new DirectPipeline();
    this.onResize();
  }

  constructor(container: HTMLElement) {
    this.three = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.shadowMap.enabled = false;
    this.three.info.autoReset = false; // считаем статистику за кадр целиком (сцена + пост-проход)
    container.appendChild(this.three.domElement);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
    this.scene.add(this.camera); // чтобы дочерние объекты камеры (фонарик) рендерились

    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  get canvas(): HTMLCanvasElement {
    return this.three.domElement;
  }

  setShadows(enabled: boolean): void {
    this.three.shadowMap.enabled = enabled;
    this.three.shadowMap.type = THREE.PCFShadowMap;
    // Материалы нужно перекомпилировать при смене режима теней.
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
  }

  render(): void {
    this.three.info.reset();
    this.pipeline.render(this.three, this.scene, this.camera);
  }

  /** Статистика для отладочной панели. */
  stats(): { calls: number; triangles: number; geometries: number } {
    const info = this.three.info;
    return { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries };
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.pipeline.dispose();
    this.three.dispose();
    this.three.domElement.remove();
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.three.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pipeline.setSize(w, h, this.three.getPixelRatio());
  };
}
