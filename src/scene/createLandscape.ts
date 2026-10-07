import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { fbm2, hash2, ridged2 } from './noise'

export type QualityLevel = 'high' | 'low'

export interface LandscapeHandle {
  setQuality(level: QualityLevel | 'auto'): void
  dispose(): void
}

export interface LandscapeOptions {
  quality?: QualityLevel | 'auto'
  reducedMotion?: boolean
  onReady?: () => void
  /** 连续掉帧自动降档时通知外部 */
  onAutoDegrade?: () => void
}

/* ------------------------------------------------------------------ *
 * 暮色山谷：太阳压得很低，暖光扫过山脊，湖面接住整片天空。
 * ------------------------------------------------------------------ */

const SUN_DIR = new THREE.Vector3(0.4, 0.088, -0.91).normalize()

const PALETTE = {
  skyTop: new THREE.Color('#03040c'),
  skyMid: new THREE.Color('#1a163c'),
  skyHorizon: new THREE.Color('#ad5a55'),
  cloud: new THREE.Color('#514472'),
  sun: new THREE.Color('#ffd0a0'),
  fog: new THREE.Color('#5c4f85'),
  waterDeep: new THREE.Color('#05081c'),
  ridgeLow: new THREE.Color('#080c26'),
  ridgeHigh: new THREE.Color('#222456'),
  ridgePeak: new THREE.Color('#8d7ba6'),
  ridgeFarLow: new THREE.Color('#1d1f4a'),
  ridgeFarHigh: new THREE.Color('#443a70'),
  ridgeFarPeak: new THREE.Color('#a284ab'),
  treeTrunk: new THREE.Color('#1b1526'),
  treeBody: new THREE.Color('#0b2426'),
  treeTip: new THREE.Color('#12332e'),
  rock: new THREE.Color('#101433'),
} as const

const QUALITY: Record<QualityLevel, { maxDpr: number; bloom: boolean; particles: number; stars: number; trees: number; detail: number }> = {
  high: { maxDpr: 2, bloom: true, particles: 320, stars: 900, trees: 30, detail: 1 },
  low: { maxDpr: 1, bloom: false, particles: 120, stars: 380, trees: 14, detail: 0.55 },
}

interface SharedUniforms {
  uTime: THREE.IUniform<number>
  uSunDir: THREE.IUniform<THREE.Vector3>
  uSunColor: THREE.IUniform<THREE.Color>
  uSkyTop: THREE.IUniform<THREE.Color>
  uSkyMid: THREE.IUniform<THREE.Color>
  uSkyHorizon: THREE.IUniform<THREE.Color>
  uCloudColor: THREE.IUniform<THREE.Color>
  uFogColor: THREE.IUniform<THREE.Color>
  uPixelRatio: THREE.IUniform<number>
}

/** 通用噪声：天空的云带与湖面的波纹共用 */
const GLSL_NOISE = /* glsl */ `
float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise21(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm21(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise21(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
`

/** 天空配色函数：天空球与湖面反射共用，保证水天同色 */
const GLSL_SKY = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uSkyHorizon;
uniform vec3 uCloudColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uTime;

vec3 skyColor(vec3 dir) {
  dir = normalize(dir);
  float h = dir.y;
  // 用很宽的过渡带做渐变：窄过渡在广角下会露出一条明显的“接缝”
  vec3 col = mix(uSkyHorizon, uSkyMid, smoothstep(-0.07, 0.52, h));
  col = mix(col, uSkyTop, smoothstep(0.30, 1.05, h));

  float s = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(s, 12.0) * 0.20;
  col += uSunColor * pow(s, 320.0) * 0.50;
  col += uSunColor * clamp(pow(s, 5200.0), 0.0, 1.0) * 1.35;

  // 云带：把方向投影到 y = 1 的平面上做二维噪声。
  // 注意：越靠近地平线这个投影被拉得越长，所以漂移必须极慢 ——
  // 否则几分钟内整片天空的云量就翻一遍，观感像“换了张图”。
  vec2 cloudUv = dir.xz / max(h, 0.16) * 0.36;
  float cl = fbm21(cloudUv + vec2(uTime * 0.0009, uTime * 0.0004));
  float cl2 = fbm21(cloudUv * 3.1 - vec2(uTime * 0.0021, 0.0));
  float cloudMask = smoothstep(0.66, 1.06, cl * 0.75 + cl2 * 0.35) * smoothstep(0.03, 0.45, h);
  col = mix(col, mix(uCloudColor, uSunColor, pow(s, 2.5) * 0.6), cloudMask * 0.20);

  return col;
}
`

/** 山体/地表共用的顶点着色器 */
const GLSL_TERRAIN_VERTEX = /* glsl */ `
attribute float aHeight;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight01;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vHeight01 = aHeight;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

/** 山体/地表共用的片元着色器：配色按高度，另加迎光轮廓与大气透视 */
const GLSL_TERRAIN_FRAGMENT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight01;
uniform vec3 uRidgeLow;
uniform vec3 uRidgeHigh;
uniform vec3 uRidgePeak;
uniform vec3 uFogColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uFogDensity;
uniform float uAmbient;

void main() {
  vec3 n = normalize(vNormalW);
  vec3 sunDir = normalize(uSunDir);
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float h = clamp(vHeight01, 0.0, 1.0);

  vec3 base = mix(uRidgeLow, uRidgeHigh, smoothstep(0.02, 0.58, h));
  base = mix(base, uRidgePeak, smoothstep(0.62, 0.97, h));

  float wrap = dot(n, sunDir) * 0.5 + 0.5;
  vec3 col = base * (uAmbient + (1.0 - uAmbient) * 1.15 * wrap);

  float ndl = max(dot(n, sunDir), 0.0);
  col += uSunColor * pow(ndl, 5.0) * 0.30;

  float rim = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
  col += uSunColor * rim * 0.28 * max(dot(sunDir, viewDir), 0.0);

  float dist = length(cameraPosition - vWorld);
  float fog = 1.0 - exp(-dist * uFogDensity);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`

function createSharedUniforms(pixelRatio: number): SharedUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uSunColor: { value: PALETTE.sun.clone() },
    uSkyTop: { value: PALETTE.skyTop.clone() },
    uSkyMid: { value: PALETTE.skyMid.clone() },
    uSkyHorizon: { value: PALETTE.skyHorizon.clone() },
    uCloudColor: { value: PALETTE.cloud.clone() },
    uFogColor: { value: PALETTE.fog.clone() },
    uPixelRatio: { value: pixelRatio },
  }
}

/* ------------------------------ 天空 ------------------------------ */

function buildSky(shared: SharedUniforms): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(16000, 40, 24)
  const material = new THREE.ShaderMaterial({
    uniforms: { ...shared },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${GLSL_NOISE}
      ${GLSL_SKY}
      void main() {
        gl_FragColor = vec4(skyColor(vDir), 1.0);
      }
    `,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = -100
  mesh.frustumCulled = false
  return mesh
}

/* ------------------------------ 星空 ------------------------------ */

function buildStars(shared: SharedUniforms, maxCount: number): THREE.Points {
  const positions = new Float32Array(maxCount * 3)
  const sizes = new Float32Array(maxCount)
  const phases = new Float32Array(maxCount)
  const radius = 13000

  for (let i = 0; i < maxCount; i += 1) {
    const theta = hash2(i, 1, 7) * Math.PI * 2
    const y = Math.pow(hash2(i, 2, 11), 0.7)
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    positions[i * 3] = Math.cos(theta) * ring * radius
    positions[i * 3 + 1] = y * radius
    positions[i * 3 + 2] = Math.sin(theta) * ring * radius
    sizes[i] = 1.1 + hash2(i, 3, 13) * 2.5
    phases[i] = hash2(i, 4, 17) * Math.PI * 2
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uPixelRatio: shared.uPixelRatio, uSunDir: shared.uSunDir },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform vec3 uSunDir;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio;
        vec3 dir = normalize(position);
        float horizonFade = smoothstep(0.015, 0.30, dir.y);
        float sunFade = 1.0 - smoothstep(0.30, 0.95, max(dot(dir, normalize(uSunDir)), 0.0));
        float twinkle = 0.62 + 0.38 * sin(uTime * 1.7 + aPhase);
        vAlpha = horizonFade * sunFade * twinkle;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = smoothstep(0.5, 0.04, d) * vAlpha;
        if (alpha <= 0.003) discard;
        gl_FragColor = vec4(vec3(0.86, 0.9, 1.0), alpha);
      }
    `,
  })

  const points = new THREE.Points(geometry, material)
  points.renderOrder = -90
  points.frustumCulled = false
  return points
}

/* --------------------------- 山体与地表 --------------------------- */

interface RidgeConfig {
  /** 山脊中心所在的 z */
  z: number
  width: number
  depth: number
  segmentsX: number
  segmentsZ: number
  /** 山脚基准高度（负数保证边缘沉在水下，不露硬边） */
  baseY: number
  amplitude: number
  seed: number
  frequency: number
  fogDensity: number
  ambient: number
  colors: { low: THREE.Color; high: THREE.Color; peak: THREE.Color }
}

/** 高度场：建模和种树共用同一个函数，树才会稳稳站在坡上 */
function ridgeHeightAt(config: RidgeConfig, x: number, localZ: number): number {
  const ridge = ridged2(x * config.frequency, (config.z + localZ) * config.frequency * 0.32, {
    octaves: 5,
    seed: config.seed,
  })
  const macro = fbm2(x * config.frequency * 0.16, config.seed * 0.37, { octaves: 2, seed: config.seed + 5 })
  const falloff = Math.exp(-Math.pow(Math.abs(localZ) / (config.depth * 0.4), 2.1))
  return config.baseY + config.amplitude * ridge * (0.28 + 0.92 * macro) * falloff
}

function buildRidge(shared: SharedUniforms, config: RidgeConfig, detail: number): THREE.Mesh {
  const segmentsX = Math.max(24, Math.round(config.segmentsX * detail))
  const segmentsZ = Math.max(8, Math.round(config.segmentsZ * detail))

  const source = new THREE.PlaneGeometry(config.width, config.depth, segmentsX, segmentsZ)
  source.rotateX(-Math.PI / 2)

  const position = source.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < position.count; i += 1) {
    position.setY(i, ridgeHeightAt(config, position.getX(i), position.getZ(i)))
  }
  position.needsUpdate = true

  // 低多边形硬边：非索引化后逐面法线
  const geometry = source.toNonIndexed()
  source.dispose()
  geometry.computeVertexNormals()

  const flatPosition = geometry.attributes.position as THREE.BufferAttribute
  const heightAttribute = new Float32Array(flatPosition.count)
  for (let i = 0; i < flatPosition.count; i += 1) {
    const y = flatPosition.getY(i)
    heightAttribute[i] = THREE.MathUtils.clamp((y - config.baseY) / Math.max(config.amplitude, 0.0001), 0, 1)
  }
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heightAttribute, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uRidgeLow: { value: config.colors.low.clone() },
      uRidgeHigh: { value: config.colors.high.clone() },
      uRidgePeak: { value: config.colors.peak.clone() },
      uFogDensity: { value: config.fogDensity },
      uAmbient: { value: config.ambient },
    },
    fog: false,
    vertexShader: GLSL_TERRAIN_VERTEX,
    fragmentShader: GLSL_TERRAIN_FRAGMENT,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.z = config.z
  return mesh
}

/* ------------------------------ 湖面 ------------------------------ */

function buildWater(shared: SharedUniforms): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(30000, 30000, 1, 1)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uWaterDeep: { value: PALETTE.waterDeep.clone() },
      uFogDensity: { value: 0.00009 },
    },
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform vec3 uWaterDeep;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      ${GLSL_NOISE}
      ${GLSL_SKY}

      void main() {
        vec2 p = vWorld.xz;
        // 各向异性采样：x 方向频率低、z 方向频率高 → 水面呈现横向长条波纹
        vec2 q1 = vec2(p.x * 0.030, p.y * 0.11);

        float r1 = noise21(q1 + vec2(uTime * 0.30, uTime * 0.10));
        float r2 = noise21(q1 * 2.4 - vec2(uTime * 0.22, uTime * 0.34));
        float r3 = noise21(q1 * 6.1 + vec2(uTime * 0.55, -uTime * 0.22));
        float r4 = noise21(q1 * 15.0 - vec2(uTime * 1.1, uTime * 0.5));

        vec3 nrm = normalize(vec3(
          (r1 - 0.5) * 0.16 + (r2 - 0.5) * 0.09 + (r4 - 0.5) * 0.03,
          1.0,
          (r2 - 0.5) * 0.14 + (r3 - 0.5) * 0.09 + (r4 - 0.5) * 0.03
        ));

        vec3 viewVec = cameraPosition - vWorld;
        float dist = length(viewVec);
        vec3 viewDir = viewVec / max(dist, 0.0001);
        vec3 refl = reflect(-viewDir, nrm);
        vec3 sunDir = normalize(uSunDir);

        vec3 sky = skyColor(refl);
        float fres = pow(1.0 - clamp(dot(viewDir, nrm), 0.0, 1.0), 4.5);
        vec3 col = mix(uWaterDeep, sky, clamp(0.05 + fres * 0.85, 0.0, 1.0));

        float align = max(dot(refl, sunDir), 0.0);
        col += uSunColor * clamp(pow(align, 420.0), 0.0, 1.0) * 1.1;
        col += uSunColor * pow(align, 14.0) * 0.07;

        float fog = 1.0 - exp(-dist * uFogDensity);
        col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = 0
  return mesh
}

/* ------------------------------ 松树 ------------------------------ */

function paint(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

function buildTrees(hill: RidgeConfig, maxCount: number): THREE.InstancedMesh {
  const trunk = new THREE.CylinderGeometry(0.4, 0.62, 4.4, 5)
  trunk.translate(0, 2.2, 0)
  const lower = new THREE.ConeGeometry(2.4, 9.5, 6)
  lower.translate(0, 7.2, 0)
  const upper = new THREE.ConeGeometry(1.45, 5.2, 6)
  upper.translate(0, 12.2, 0)

  const geometry =
    mergeGeometries(
      [
        paint(trunk, PALETTE.treeTrunk),
        paint(lower, PALETTE.treeBody),
        paint(upper, PALETTE.treeTip),
      ],
      false,
    ) ?? lower

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.94,
    metalness: 0,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, maxCount)
  const dummy = new THREE.Object3D()
  let placed = 0

  // 沿近山的临水缓坡种树：高度太低是水下，太高是陡壁，都不长树
  for (let i = 0; i < maxCount * 8 && placed < maxCount; i += 1) {
    const x = (hash2(i, 31, 3) - 0.5) * 2400
    const localZ = 60 + hash2(i, 32, 5) * 420
    const y = ridgeHeightAt(hill, x, localZ)
    if (y < 3 || y > 46) continue

    dummy.position.set(x, y - 1.6, hill.z + localZ)
    dummy.rotation.set(0, hash2(i, 33, 7) * Math.PI * 2, 0)
    dummy.scale.setScalar(0.62 + hash2(i, 34, 9) * 1.0)
    dummy.updateMatrix()
    mesh.setMatrixAt(placed, dummy.matrix)
    placed += 1
  }

  mesh.count = Math.max(1, placed)
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

/* --------------------------- 水里的礁石 --------------------------- */

function buildRocks(maxCount: number): THREE.InstancedMesh {
  const geometry = new THREE.IcosahedronGeometry(1, 0)
  geometry.scale(1.5, 0.8, 1.2)
  const material = new THREE.MeshStandardMaterial({
    color: PALETTE.rock,
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, maxCount)
  const dummy = new THREE.Object3D()
  let placed = 0

  for (let i = 0; i < maxCount * 4 && placed < maxCount; i += 1) {
    const x = (hash2(i, 41, 11) - 0.5) * 1500
    const z = -120 - hash2(i, 42, 13) * 380
    if (Math.abs(x) < 90 && z > -260) continue

    const scale = 2.2 + hash2(i, 43, 17) * 6
    dummy.position.set(x, -scale * 0.28, z)
    dummy.rotation.set(hash2(i, 44, 19) * 0.5, hash2(i, 45, 23) * Math.PI * 2, hash2(i, 46, 29) * 0.4)
    dummy.scale.set(scale, scale * (0.5 + hash2(i, 47, 31) * 0.5), scale)
    dummy.updateMatrix()
    mesh.setMatrixAt(placed, dummy.matrix)
    placed += 1
  }

  mesh.count = Math.max(1, placed)
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

/* --------------------------- 漂浮的光尘 --------------------------- */

function buildMotes(maxCount: number): THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const positions = new Float32Array(maxCount * 3)
  const seeds = new Float32Array(maxCount)
  const speeds = new Float32Array(maxCount)

  for (let i = 0; i < maxCount; i += 1) {
    positions[i * 3] = (hash2(i, 21, 13) - 0.5) * 1100
    positions[i * 3 + 1] = 2 + hash2(i, 22, 17) * 70
    positions[i * 3 + 2] = -560 + hash2(i, 23, 19) * 820
    seeds[i] = hash2(i, 24, 23) * Math.PI * 2
    speeds[i] = 1.4 + hash2(i, 25, 29) * 3.2
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.userData.speeds = speeds

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1 },
      uTime: { value: 0 },
      uSunColor: { value: PALETTE.sun.clone() },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uPixelRatio;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = max(-mv.z, 1.0);
        gl_PointSize = (26.0 + 14.0 * sin(uTime * 0.8 + aSeed)) * uPixelRatio / dist;
        vAlpha = smoothstep(1500.0, 240.0, dist) * (0.30 + 0.30 * sin(uTime * 1.1 + aSeed));
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      uniform vec3 uSunColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = smoothstep(0.5, 0.0, d) * vAlpha;
        if (alpha <= 0.002) discard;
        gl_FragColor = vec4(uSunColor, alpha);
      }
    `,
  })

  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  return points
}

/* ------------------------------ 主入口 ------------------------------ */

export function createLandscape(container: HTMLElement, options: LandscapeOptions = {}): LandscapeHandle {
  const prefersReducedMotion =
    options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let level: QualityLevel =
    options.quality && options.quality !== 'auto'
      ? options.quality
      : window.innerWidth < 820 || (navigator.hardwareConcurrency ?? 4) <= 4
        ? 'low'
        : 'high'
  let autoMode = !options.quality || options.quality === 'auto'

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setClearColor(0x04050e, 1)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 40000)
  camera.position.set(0, 19, 205)

  const shared = createSharedUniforms(renderer.getPixelRatio())
  const detail = QUALITY[level].detail

  const nearHills: RidgeConfig = {
    z: -600,
    width: 6200,
    depth: 920,
    segmentsX: 260,
    segmentsZ: 64,
    baseY: -24,
    amplitude: 215,
    seed: 7,
    frequency: 0.0055,
    fogDensity: 0.00026,
    ambient: 0.2,
    colors: { low: PALETTE.ridgeLow, high: PALETTE.ridgeHigh, peak: PALETTE.ridgePeak },
  }

  const midRidge: RidgeConfig = {
    z: -1500,
    width: 12000,
    depth: 1600,
    segmentsX: 220,
    segmentsZ: 52,
    baseY: -70,
    amplitude: 380,
    seed: 19,
    frequency: 0.003,
    fogDensity: 0.00030,
    ambient: 0.28,
    colors: { low: PALETTE.ridgeFarLow, high: PALETTE.ridgeFarHigh, peak: PALETTE.ridgeFarPeak },
  }

  const farRidge: RidgeConfig = {
    z: -3200,
    width: 20000,
    depth: 2400,
    segmentsX: 180,
    segmentsZ: 42,
    baseY: -120,
    amplitude: 520,
    seed: 37,
    frequency: 0.0018,
    fogDensity: 0.00044,
    ambient: 0.34,
    colors: { low: PALETTE.ridgeFarLow, high: PALETTE.ridgeFarHigh, peak: PALETTE.ridgeFarPeak },
  }

  const sky = buildSky(shared)
  const stars = buildStars(shared, QUALITY.high.stars)
  const water = buildWater(shared)
  const hills = buildRidge(shared, nearHills, detail)
  const mid = buildRidge(shared, midRidge, detail)
  const far = buildRidge(shared, farRidge, detail)
  const trees = buildTrees(nearHills, QUALITY.high.trees)
  const rocks = buildRocks(14)
  const motes = buildMotes(QUALITY.high.particles)

  scene.add(sky, stars, water, far, mid, hills, trees, rocks, motes)

  const sunLight = new THREE.DirectionalLight(0xffc48a, 2.2)
  sunLight.position.copy(SUN_DIR).multiplyScalar(1500)
  const fillLight = new THREE.HemisphereLight(0x5b6bb0, 0x140f2a, 0.55)
  scene.add(sunLight, fillLight)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.7, 0.82)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  /* ------------------------------- 尺寸 ------------------------------- */
  const resize = () => {
    const width = container.clientWidth || window.innerWidth
    const height = container.clientHeight || window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[level].maxDpr)
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    camera.aspect = width / Math.max(height, 1)
    camera.updateProjectionMatrix()
    shared.uPixelRatio.value = dpr
    motes.material.uniforms.uPixelRatio!.value = dpr
  }

  const applyQuality = () => {
    const settings = QUALITY[level]
    bloom.enabled = settings.bloom
    trees.count = Math.max(1, Math.min(settings.trees, trees.instanceMatrix.count))
    stars.geometry.setDrawRange(0, settings.stars)
    motes.geometry.setDrawRange(0, settings.particles)
    resize()
  }

  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()
  applyQuality()

  /* ------------------------------ 交互 ------------------------------ */
  const pointer = { x: 0, y: 0 }
  const smoothPointer = { x: 0, y: 0 }

  const onPointerMove = (event: PointerEvent) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })

  /* ------------------------------ 循环 ------------------------------ */
  const CAMERA_BASE = new THREE.Vector3(0, 19, 196)
  const LOOK_BASE = new THREE.Vector3(0, 52, -700)
  const lookTarget = new THREE.Vector3().copy(LOOK_BASE)
  const motePositions = motes.geometry.attributes.position as THREE.BufferAttribute
  const moteSpeeds = motes.geometry.userData.speeds as Float32Array

  const clock = new THREE.Clock()
  let frameHandle = 0
  let frameAccumulator = 0
  let frameCount = 0
  let disposed = false

  const tick = () => {
    if (disposed) return
    frameHandle = requestAnimationFrame(tick)

    const delta = Math.min(clock.getDelta(), 0.05)
    const elapsed = clock.elapsedTime
    const motion = prefersReducedMotion ? 0 : 1

    shared.uTime.value = elapsed
    motes.material.uniforms.uTime!.value = elapsed

    if (motion > 0) {
      for (let i = 0; i < motePositions.count; i += 1) {
        const y = motePositions.getY(i) + moteSpeeds[i]! * delta
        const x = motePositions.getX(i) + Math.sin(elapsed * 0.25 + i) * delta * 1.4
        motePositions.setY(i, y > 76 ? 1.5 : y)
        motePositions.setX(i, x)
      }
      motePositions.needsUpdate = true
    }

    smoothPointer.x += (pointer.x - smoothPointer.x) * Math.min(1, delta * 2.2)
    smoothPointer.y += (pointer.y - smoothPointer.y) * Math.min(1, delta * 2.2)

    camera.position.set(
      CAMERA_BASE.x + Math.sin(elapsed * 0.07) * 20 * motion + smoothPointer.x * 26,
      CAMERA_BASE.y + Math.sin(elapsed * 0.05 + 0.7) * 5 * motion - smoothPointer.y * 9,
      CAMERA_BASE.z + Math.cos(elapsed * 0.043) * 14 * motion,
    )
    lookTarget.set(
      LOOK_BASE.x + smoothPointer.x * 54,
      LOOK_BASE.y + smoothPointer.y * 20 + Math.sin(elapsed * 0.09) * 3 * motion,
      LOOK_BASE.z,
    )
    camera.lookAt(lookTarget)

    sky.position.copy(camera.position)
    stars.position.copy(camera.position)

    composer.render()

    // 自适应画质：连续掉帧就降一档，只降一次
    if (autoMode && level === 'high') {
      frameAccumulator += delta
      frameCount += 1
      if (frameCount >= 90) {
        const averageMs = (frameAccumulator / frameCount) * 1000
        frameAccumulator = 0
        frameCount = 0
        if (averageMs > 26) {
          level = 'low'
          applyQuality()
          options.onAutoDegrade?.()
        }
      }
    }
  }

  frameHandle = requestAnimationFrame(tick)
  options.onReady?.()

  const onVisibility = () => {
    if (!document.hidden) clock.getDelta()
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    setQuality(next) {
      if (next === 'auto') {
        autoMode = true
        level = window.innerWidth < 820 ? 'low' : 'high'
      } else {
        autoMode = false
        level = next
      }
      applyQuality()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frameHandle)
      observer.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)

      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material?.dispose()
      })

      composer.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
