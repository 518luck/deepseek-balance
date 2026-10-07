import { describe, expect, it } from 'vitest'
import { MODEL_PRICES, describeEstimate, estimateUsage, isPriceSupported, PRICING_VERIFIED_ON } from '../src/lib/pricing'

describe('estimateUsage', () => {
  it('人民币余额：按高峰 / 空闲两档给出区间', () => {
    const rows = estimateUsage(110, 'CNY')
    expect(rows).not.toBeNull()
    expect(rows).toHaveLength(MODEL_PRICES.length)

    const flash = rows![0]!
    // 典型一轮 = 4K 输入（未命中缓存）+ 1K 输出；高峰 0.021 元 / 空闲 0.0105 元
    expect(flash.modelId).toBe('deepseek-flash')
    expect(flash.roundsLow).toBe(5238)
    expect(flash.roundsHigh).toBe(10476)
    expect(flash.roundsHigh).toBeGreaterThan(flash.roundsLow)

    const pro = rows![1]!
    expect(pro.modelId).toBe('deepseek-v4-pro')
    expect(pro.roundsLow).toBeLessThan(flash.roundsLow)
  })

  it('美元余额用美元牌价，不与人民币混算', () => {
    const rows = estimateUsage(110, 'USD')
    expect(rows![0]!.roundsLow).toBe(Math.floor(110 / 0.0024))
  })

  it('币种不支持或金额为 0 时返回 null（不猜）', () => {
    expect(estimateUsage(110, 'JPY')).toBeNull()
    expect(estimateUsage(0, 'CNY')).toBeNull()
    expect(estimateUsage(100, '')).toBeNull()
    expect(estimateUsage(Number.NaN, 'CNY')).toBeNull()
  })

  it('币种判断大小写不敏感', () => {
    expect(isPriceSupported('cny')).toBe(true)
    expect(isPriceSupported('usd')).toBe(true)
    expect(isPriceSupported('eur')).toBe(false)
  })

  it('牌价表格带有核对日期，避免长期失真', () => {
    expect(PRICING_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('describeEstimate', () => {
  it('输出一句完整的人话', () => {
    const rows = estimateUsage(110, 'CNY')!
    const sentence = describeEstimate(rows[0]!)
    expect(sentence).toContain('DeepSeek Flash')
    expect(sentence).toContain('轮典型对话')
    expect(sentence).toContain('tokens')
  })
})
