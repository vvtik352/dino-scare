import * as THREE from 'three';
import type { RenderPipeline } from './renderer';

/**
 * PSX/PS1-стиль (шаг 7):
 *  - патч материалов: vertex snapping (дрожание вершин) и аффинные UV (плавание текстур);
 *  - пайплайн: рендер в низкое разрешение + пост-проход (5 бит на канал, дизеринг Байера,
 *    приглушённая палитра) с nearest-апскейлом на экран.
 *
 * Общие uniform-ы передаются в шейдеры по ссылке — меняем значение в одном месте, видят все.
 */
export class PsxUniforms {
  /** Разрешение низкоразрешённого буфера (для сетки привязки вершин). */
  readonly snapRes = { value: new THREE.Vector2(480, 270) };
  /** 0 — без дрожания, 1 — сильное (до 2.5 пикселя). */
  readonly jitter = { value: 0.5 };
  /** 0 — перспективно-корректные UV, 1 — полностью аффинные, как на PS1. */
  readonly affine = { value: 0.4 };
}

const VERT_DECL = /* glsl */ `
uniform vec2 uPsxSnapRes;
uniform float uPsxJitter;
#ifdef USE_MAP
varying vec3 vPsxAffine;
#endif
`;

const VERT_SNAP = /* glsl */ `
#include <project_vertex>
if (uPsxJitter > 0.0 && gl_Position.w > 0.0) {
  vec2 psxGrid = uPsxSnapRes / (2.0 * (1.0 + uPsxJitter * 1.5));
  vec4 psxP = gl_Position;
  psxP.xy = floor(psxP.xy / psxP.w * psxGrid + 0.5) / psxGrid * psxP.w;
  gl_Position = psxP;
}
#ifdef USE_MAP
// uv*w и w интерполируются перспективно-корректно, их отношение — линейно по экрану (аффинно).
vPsxAffine = vec3(vMapUv * gl_Position.w, gl_Position.w);
#endif
`;

const FRAG_DECL = /* glsl */ `
#ifdef USE_MAP
uniform float uPsxAffine;
varying vec3 vPsxAffine;
#endif
`;

const FRAG_MAP = /* glsl */ `
#ifdef USE_MAP
  vec2 psxUv = mix(vMapUv, vPsxAffine.xy / vPsxAffine.z, uPsxAffine);
  diffuseColor *= texture2D(map, psxUv);
#endif
`;

export function applyPsxPatch(material: THREE.Material, u: PsxUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPsxSnapRes = u.snapRes;
    shader.uniforms.uPsxJitter = u.jitter;
    shader.uniforms.uPsxAffine = u.affine;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <project_vertex>', VERT_SNAP);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <map_fragment>', FRAG_MAP);
  };
  material.customProgramCacheKey = () => 'psx1';
}

// ---------------------------------------------------------------------------

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const POST_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uLevels;
uniform float uDither;
varying vec2 vUv;

float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  // Матрица Байера 4×4 / 16
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return m[i] / 16.0;
}

vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 c = toSRGB(max(texture2D(tDiffuse, vUv).rgb, 0.0));
  // Приглушённая палитра: частичное обесцвечивание, холодные тени.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 0.8);
  c += vec3(-0.006, 0.0, 0.014) * (1.0 - l);
  // 15-бит цвет PS1 + упорядоченный дизеринг в пикселях низкого разрешения.
  vec2 px = floor(vUv * uRes);
  float d = (bayer4(px) - 0.5) * uDither;
  c = floor(c * (uLevels - 1.0) + 0.5 + d) / (uLevels - 1.0);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export class PsxPipeline implements RenderPipeline {
  private target: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;

  constructor(private readonly uniforms: PsxUniforms, public height: number) {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uRes: { value: new THREE.Vector2(4, 4) },
        uLevels: { value: 32 },
        uDither: { value: 1 },
      },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  setSize(width: number, height: number): void {
    const h = this.height;
    const w = Math.max(1, Math.round(h * (width / height)));
    this.target.setSize(w, h);
    (this.material.uniforms.uRes as THREE.IUniform<THREE.Vector2>).value.set(w, h);
    this.uniforms.snapRes.value.set(w, h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.postScene, this.postCamera);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
