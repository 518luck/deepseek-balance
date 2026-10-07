/** 金额、数量、时间的展示格式化 —— 一律面向“人能一眼看懂”。 */

const CURRENCY_META: Record<string, { symbol: string; name: string; english: string }> = {
  CNY: { symbol: '¥', name: '人民币', english: 'Chinese Yuan' },
  USD: { symbol: '$', name: '美元', english: 'US Dollar' },
}

/** 把接口返回的字符串金额安全地转成数字（脏数据一律当 0，绝不抛错）。 */
export function parseAmount(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw !== 'string') return 0
  const cleaned = raw.replace(/[,\s，]/g, '')
  const value = Number.parseFloat(cleaned)
  return Number.isFinite(value) ? value : 0
}

export function currencyMeta(currency: string): { symbol: string; name: string; english: string } {
  const key = (currency || '').toUpperCase()
  return CURRENCY_META[key] ?? { symbol: '', name: key || '未知币种', english: key }
}

/** 带千分位与合理小数位的金额，例如 ¥110.00、$0.0032 */
export function formatMoney(amount: number, currency: string): string {
  const { symbol } = currencyMeta(currency)
  const abs = Math.abs(amount)
  const decimals = abs === 0 ? 2 : abs < 0.01 ? 4 : 2
  const body = amount.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${symbol}${body}`
}

/** 整数千分位：5238 -> 5,238 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

/** 中文语境下的紧凑数字：3670 万 / 1.23 亿（用于 token 量级） */
export function formatCompactCN(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs < 10_000) return formatCount(value)
  if (abs < 100_000_000) {
    const v = value / 10_000
    return `${v >= 100 ? formatCount(v) : v.toFixed(1)} 万`
  }
  const v = value / 100_000_000
  return `${v >= 100 ? formatCount(v) : v.toFixed(2)} 亿`
}

/** 轮数这类“次数”：太大时切成万，避免一长串数字 */
export function formatRounds(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 10_000) return formatCount(value)
  return formatCompactCN(value)
}

/** 占比（0-100，保留一位小数；用于余额构成条） */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, (part / total) * 100))
}

/** 2026-10-07 13:26 */
export function formatLocalTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 0.28 秒 / 1.4 秒 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} 秒`
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
