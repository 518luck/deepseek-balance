/** 确定性噪声：同一份种子在任何设备上都会长出同一片山。 */

export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** 双线性插值的 value noise，返回 0..1 */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi

  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)

  const u = smooth(xf)
  const v = smooth(yf)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

export interface FbmOptions {
  octaves?: number
  frequency?: number
  lacunarity?: number
  gain?: number
  seed?: number
}

/** 分形叠加噪声，返回 0..1 */
export function fbm2(x: number, y: number, options: FbmOptions = {}): number {
  const { octaves = 4, frequency = 1, lacunarity = 2.03, gain = 0.5, seed = 0 } = options
  let amplitude = 1
  let sum = 0
  let norm = 0
  let fx = x * frequency
  let fy = y * frequency

  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * valueNoise2(fx, fy, seed + i * 17)
    norm += amplitude
    amplitude *= gain
    fx *= lacunarity
    fy *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}

/** 脊状噪声：把 noise 折起来，得到刀刃一样的山脊，返回 0..1 */
export function ridged2(x: number, y: number, options: FbmOptions = {}): number {
  const { octaves = 5, frequency = 1, lacunarity = 2.07, gain = 0.5, seed = 0 } = options
  let amplitude = 1
  let sum = 0
  let norm = 0
  let fx = x * frequency
  let fy = y * frequency

  for (let i = 0; i < octaves; i += 1) {
    const n = valueNoise2(fx, fy, seed + i * 31)
    const ridge = 1 - Math.abs(n * 2 - 1)
    sum += amplitude * ridge * ridge
    norm += amplitude
    amplitude *= gain
    fx *= lacunarity
    fy *= lacunarity
  }
  return norm > 0 ? sum / norm : 0
}
