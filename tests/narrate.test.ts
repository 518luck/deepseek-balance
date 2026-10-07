import { describe, expect, it } from 'vitest'
import type { ErrorKind, QueryFailure, QuerySuccess } from '../src/lib/deepseek'
import { balanceSegments, narrateFailure, narrateSuccess, type NarrationPlan } from '../src/lib/narrate'
import { formatMoney } from '../src/lib/format'

const FETCHED_AT = new Date('2026-10-07T13:26:00+08:00').getTime()

function success(overrides: Partial<QuerySuccess['data']> = {}, latencyMs = 268): QuerySuccess {
  return {
    ok: true,
    via: 'direct',
    latencyMs,
    fetchedAt: FETCHED_AT,
    data: {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
      ...overrides,
    },
  }
}

function failureOf(kind: ErrorKind, extra: Partial<QueryFailure> = {}): QueryFailure {
  return { ok: false, via: 'direct', latencyMs: 120, fetchedAt: FETCHED_AT, kind, ...extra }
}

/** 把播报稿里的所有人类可读文本拼起来，用于断言“没有泄露原始字段” */
function allText(plan: NarrationPlan): string {
  return plan.blocks
    .map((block) => {
      if (block.kind === 'text') return block.text
      if (block.kind === 'estimate') return block.note
      if (block.kind === 'actions') return block.actions.map((action) => `${action.label}${action.hint ?? ''}`).join(' ')
      return ''
    })
    .join('\n')
}

const RAW_FIELD_NAMES = /total_balance|granted_balance|topped_up_balance|balance_infos|is_available/

describe('narrateSuccess', () => {
  it('把余额翻译成金额卡片 + 来源说明', () => {
    const plan = narrateSuccess(success())
    const text = allText(plan)

    const card = plan.blocks.find((block) => block.kind === 'balance')
    expect(card).toBeDefined()
    expect(card).toMatchObject({ currency: 'CNY', total: 110, granted: 10, toppedUp: 100, available: true })
    // 总额用大号金额卡片呈现，正文只负责解释钱的来路
    if (card?.kind !== 'balance') throw new Error('缺少余额卡片')
    expect(formatMoney(card.total, card.currency)).toBe('¥110.00')

    expect(text).toContain('¥100.00')
    expect(text).toContain('¥10.00')
    expect(text).toContain('可以继续调用')
    expect(text).toContain('268 毫秒')
  })

  it('余额构成的比例能对上（充值 90.9% / 赠送 9.1%）', () => {
    const plan = narrateSuccess(success())
    const card = plan.blocks.find((block) => block.kind === 'balance')
    if (card?.kind !== 'balance') throw new Error('缺少余额卡片')
    const segments = balanceSegments(card)
    expect(segments.toppedUp + segments.granted).toBeCloseTo(100, 5)
    expect(segments.toppedUp).toBeGreaterThan(segments.granted)
  })

  it('给出「还能聊多少轮」的粗算，并声明价格来源与假设', () => {
    const plan = narrateSuccess(success())
    const estimate = plan.blocks.find((block) => block.kind === 'estimate')
    expect(estimate).toBeDefined()
    if (estimate?.kind !== 'estimate') throw new Error('缺少估算卡片')
    expect(estimate.rows.length).toBeGreaterThan(0)
    expect(estimate.note).toContain('官方定价页')
    expect(estimate.note).toContain('估算假设')
  })

  it('余额不足时明确告知需要充值，而不是只说“不可用”', () => {
    const plan = narrateSuccess(
      success({
        is_available: false,
        balance_infos: [
          { currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
        ],
      }),
    )
    const text = allText(plan)
    expect(text).toContain('余额不足')
    expect(text).toContain('充值')
    // 余额为 0 时不硬凑估算
    expect(plan.blocks.some((block) => block.kind === 'estimate')).toBe(false)
  })

  it('多币种逐个说明，且不把两个币种混在一起算', () => {
    const plan = narrateSuccess(
      success({
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
          { currency: 'USD', total_balance: '3.20', granted_balance: '3.20', topped_up_balance: '0.00' },
        ],
      }),
    )
    const cards = plan.blocks.filter((block) => block.kind === 'balance')
    const estimates = plan.blocks.filter((block) => block.kind === 'estimate')
    expect(cards).toHaveLength(2)
    expect(estimates).toHaveLength(2)
    expect(allText(plan)).toContain('2 个币种')
    expect(allText(plan)).toContain('$3.20')
  })

  it('赠送额度为 0 时不再念“其中 ¥0.00 …”这种废话', () => {
    const plan = narrateSuccess(
      success({
        balance_infos: [
          { currency: 'CNY', total_balance: '20.00', granted_balance: '0.00', topped_up_balance: '20.00' },
        ],
      }),
    )
    const text = allText(plan)
    expect(text).toContain('全部来自你的充值')
    expect(text).not.toContain('¥0.00')
  })

  it('接口没给明细时如实说明，而不是假装有余额', () => {
    const plan = narrateSuccess(success({ balance_infos: [] }))
    const text = allText(plan)
    expect(text).toContain('没有给出任何余额明细')
    expect(plan.blocks.some((block) => block.kind === 'balance')).toBe(false)
  })

  it('提供可复制的纯文本摘要', () => {
    const plan = narrateSuccess(success())
    expect(plan.summary).toContain('¥110.00')
    expect(plan.summary).toContain('DeepSeek')
  })
})

describe('narrateFailure', () => {
  const kinds: ErrorKind[] = [
    'empty',
    'shape',
    'auth',
    'insufficient',
    'rate_limit',
    'bad_request',
    'server',
    'network',
    'timeout',
    'aborted',
    'malformed',
    'proxy_failed',
    'proxy_missing',
    'unknown',
  ]

  it('每种失败都至少给出一句人话', () => {
    for (const kind of kinds) {
      const plan = narrateFailure(failureOf(kind, { status: 401 }))
      const text = allText(plan)
      expect(text.length, kind).toBeGreaterThan(8)
      expect(plan.blocks.some((block) => block.kind === 'text'), kind).toBe(true)
    }
  })

  it('密钥无效时指向控制台，而不是甩一句 401', () => {
    const text = allText(narrateFailure(failureOf('auth', { status: 401, upstreamMessage: 'Authentication Fails' })))
    expect(text).toContain('密钥无效')
    expect(text).toContain('platform.deepseek.com/api_keys')
    expect(text).toContain('Authentication Fails')
  })

  it('网络被拦截时给出「改用本站代理」的选择，并说清密钥去向', () => {
    const plan = narrateFailure(failureOf('network', { detail: 'TypeError: Failed to fetch' }))
    const actions = plan.blocks.find((block) => block.kind === 'actions')
    if (actions?.kind !== 'actions') throw new Error('缺少操作按钮')
    expect(actions.actions.map((action) => action.id)).toContain('retry-proxy')
    const text = allText(plan)
    expect(text).toContain('不记录')
    expect(text).toContain('Failed to fetch')
  })

  it('格式可疑时允许强制查询，而不是直接拒绝', () => {
    const plan = narrateFailure(failureOf('shape'))
    const actions = plan.blocks.find((block) => block.kind === 'actions')
    if (actions?.kind !== 'actions') throw new Error('缺少操作按钮')
    expect(actions.actions[0]?.id).toBe('force-shape')
  })

  it('限流 / 服务端故障都提示可以重试', () => {
    for (const kind of ['rate_limit', 'server'] as ErrorKind[]) {
      const plan = narrateFailure(failureOf(kind, { status: 503 }))
      const actions = plan.blocks.find((block) => block.kind === 'actions')
      expect(actions?.kind, kind).toBe('actions')
    }
  })

  it('纯静态部署（没有代理）时，引导用户回到浏览器直连', () => {
    const plan = narrateFailure(failureOf('proxy_missing', { status: 404 }))
    const text = allText(plan)
    expect(text).toContain('没有部署边缘代理')
    expect(text).toContain('浏览器直连')
    const actions = plan.blocks.find((block) => block.kind === 'actions')
    if (actions?.kind !== 'actions') throw new Error('缺少操作按钮')
    expect(actions.actions.map((action) => action.id)).toEqual(['retry-direct'])
  })

  it('空白输入不触发网络请求，只提示怎么拿密钥', () => {
    const text = allText(narrateFailure(failureOf('empty')))
    expect(text).toContain('API Key')
    expect(text).toContain('sk-')
  })
})

describe('绝不把接口原始字段摆给用户看', () => {
  it('成功播报里没有下划线字段名', () => {
    expect(allText(narrateSuccess(success()))).not.toMatch(RAW_FIELD_NAMES)
  })

  it('失败播报里也没有', () => {
    const kinds: ErrorKind[] = ['empty', 'shape', 'auth', 'insufficient', 'network', 'malformed', 'unknown']
    for (const kind of kinds) {
      expect(allText(narrateFailure(failureOf(kind, { status: 400 }))), kind).not.toMatch(RAW_FIELD_NAMES)
    }
  })
})
