import { describe, expect, it } from 'vitest'
import {
  currencyMeta,
  formatCompactCN,
  formatLatency,
  formatLocalTime,
  formatMoney,
  formatRounds,
  parseAmount,
  percentOf,
  truncate,
} from '../src/lib/format'

describe('parseAmount', () => {
  it('解析正常金额字符串', () => {
    expect(parseAmount('110.00')).toBe(110)
    expect(parseAmount('0.0032')).toBe(0.0032)
    expect(parseAmount('1,234.50')).toBe(1234.5)
  })

  it('脏数据一律当 0，而不是抛错', () => {
    expect(parseAmount('')).toBe(0)
    expect(parseAmount('abc')).toBe(0)
    expect(parseAmount(null)).toBe(0)
    expect(parseAmount(undefined)).toBe(0)
    expect(parseAmount(Number.NaN)).toBe(0)
  })
})

describe('formatMoney', () => {
  it('按币种给出符号与合理小数位', () => {
    expect(formatMoney(110, 'CNY')).toBe('¥110.00')
    expect(formatMoney(1000, 'CNY')).toBe('¥1,000.00')
    expect(formatMoney(42.5, 'USD')).toBe('$42.50')
    expect(formatMoney(0, 'CNY')).toBe('¥0.00')
  })

  it('极小的金额保留 4 位小数，避免看起来像 0', () => {
    expect(formatMoney(0.0032, 'USD')).toBe('$0.0032')
  })

  it('未知币种退化为「代码 + 空格」', () => {
    expect(currencyMeta('JPY').name).toBe('JPY')
    expect(formatMoney(10, 'JPY')).toBe('10.00')
  })
})

describe('数字的读法', () => {
  it('formatCompactCN 用万 / 亿', () => {
    expect(formatCompactCN(999)).toBe('999')
    expect(formatCompactCN(15_000)).toBe('1.5 万')
    expect(formatCompactCN(36_666_666)).toBe('3,667 万')
    expect(formatCompactCN(123_456_789)).toBe('1.23 亿')
  })

  it('formatRounds 小数字带千分位，大数字切万', () => {
    expect(formatRounds(5238)).toBe('5,238')
    expect(formatRounds(123_456)).toBe('12.3 万')
  })

  it('percentOf 收敛在 0-100 且不会除以零', () => {
    expect(percentOf(10, 110)).toBeCloseTo(9.09, 2)
    expect(percentOf(110, 110)).toBe(100)
    expect(percentOf(1, 0)).toBe(0)
    expect(percentOf(-5, 100)).toBe(0)
  })
})

describe('时间与耗时', () => {
  it('本地时间格式固定为 YYYY-MM-DD HH:mm', () => {
    expect(formatLocalTime(Date.now())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('耗时按量级切换单位', () => {
    expect(formatLatency(268)).toBe('268 毫秒')
    expect(formatLatency(1500)).toBe('1.50 秒')
    expect(formatLatency(23_000)).toBe('23.0 秒')
  })
})

describe('truncate', () => {
  it('压平空白并截断', () => {
    expect(truncate('a  b\n c', 20)).toBe('a b c')
    expect(truncate('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
