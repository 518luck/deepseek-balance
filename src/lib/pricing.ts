import { formatCompactCN, formatRounds } from './format'

/**
 * DeepSeek 官方牌价（每 100 万 tokens）。
 *
 * ⚠️ 价格会变：这里的数据核对于 PRICING_VERIFIED_ON，
 * 只用于“这笔钱大概能用多久”的粗略换算；真实计费以官网为准。
 */
export const PRICING_VERIFIED_ON = '2026-10-07'
export const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/** 一次“典型对话”的用量假设：4K 输入 + 1K 输出 */
export const TYPICAL_ROUND = { inputTokens: 4_000, outputTokens: 1_000 }

interface PriceSet {
  /** 缓存命中的输入价（高峰） */
  cacheHitPeak: number
  cacheHitOffPeak: number
  /** 缓存未命中的输入价（高峰） */
  cacheMissPeak: number
  cacheMissOffPeak: number
  /** 输出价（高峰） */
  outputPeak: number
  outputOffPeak: number
}

export interface ModelPrice {
  id: string
  label: string
  blurb: string
  byCurrency: Record<'CNY' | 'USD', PriceSet>
}

export const MODEL_PRICES: ModelPrice[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash',
    blurb: '轻量模型，速度快、单价低',
    byCurrency: {
      CNY: { cacheHitPeak: 0.1, cacheHitOffPeak: 0.05, cacheMissPeak: 3, cacheMissOffPeak: 1.5, outputPeak: 9, outputOffPeak: 4.5 },
      USD: { cacheHitPeak: 0.006, cacheHitOffPeak: 0.003, cacheMissPeak: 0.3, cacheMissOffPeak: 0.15, outputPeak: 1.2, outputOffPeak: 0.6 },
    },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    blurb: '旗舰模型，复杂任务更强、单价更高',
    byCurrency: {
      CNY: { cacheHitPeak: 0.3, cacheHitOffPeak: 0.15, cacheMissPeak: 9, cacheMissOffPeak: 4.5, outputPeak: 27, outputOffPeak: 13.5 },
      USD: { cacheHitPeak: 0.044, cacheHitOffPeak: 0.022, cacheMissPeak: 1.32, cacheMissOffPeak: 0.66, outputPeak: 3.96, outputOffPeak: 1.98 },
    },
  },
]

export interface EstimateRow {
  modelId: string
  model: string
  blurb: string
  /** 高峰期价格下的对话轮数（保守下限） */
  roundsLow: number
  /** 空闲时段价格下的对话轮数（乐观上限） */
  roundsHigh: number
  /** 全部用来“读”：可消化的输入 tokens 区间 */
  tokensLow: number
  tokensHigh: number
}

export function isPriceSupported(currency: string): currency is 'CNY' | 'USD' {
  const key = (currency || '').toUpperCase()
  return key === 'CNY' || key === 'USD'
}

/**
 * 把余额换算成“还能聊多少轮”，比一串 token 数字更好理解。
 * 返回 null 表示该币种没有牌价表（不猜、不编）。
 */
export function estimateUsage(total: number, currency: string): EstimateRow[] | null {
  if (!isPriceSupported(currency) || !Number.isFinite(total) || total <= 0) return null
  const key = currency.toUpperCase() as 'CNY' | 'USD'

  return MODEL_PRICES.map((model) => {
    const price = model.byCurrency[key]
    const perMillion = 1_000_000
    const costPeak =
      (TYPICAL_ROUND.inputTokens / perMillion) * price.cacheMissPeak +
      (TYPICAL_ROUND.outputTokens / perMillion) * price.outputPeak
    const costOffPeak =
      (TYPICAL_ROUND.inputTokens / perMillion) * price.cacheMissOffPeak +
      (TYPICAL_ROUND.outputTokens / perMillion) * price.outputOffPeak

    return {
      modelId: model.id,
      model: model.label,
      blurb: model.blurb,
      roundsLow: Math.floor(total / costPeak),
      roundsHigh: Math.floor(total / costOffPeak),
      tokensLow: Math.floor(total / (price.cacheMissPeak / perMillion)),
      tokensHigh: Math.floor(total / (price.cacheMissOffPeak / perMillion)),
    }
  })
}

/** 把估算结果压成一句人话，供播报使用 */
export function describeEstimate(row: EstimateRow): string {
  const rounds = row.roundsLow === row.roundsHigh
    ? `约 ${formatRounds(row.roundsLow)} 轮`
    : `约 ${formatRounds(row.roundsLow)} ~ ${formatRounds(row.roundsHigh)} 轮`
  const tokens = `${formatCompactCN(row.tokensLow)} ~ ${formatCompactCN(row.tokensHigh)} tokens`
  return `${row.model}：${rounds}典型对话，或纯读入 ${tokens}`
}
