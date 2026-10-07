import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BALANCE_ENDPOINT,
  looksLikeDeepSeekKey,
  normalizeKey,
  queryBalance,
  statusToKind,
} from '../src/lib/deepseek'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function mockFetch(implementation: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    implementation(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init),
  )
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const VALID_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
}

describe('normalizeKey', () => {
  it('清掉复制粘贴带来的杂质', () => {
    expect(normalizeKey('  sk-abc123  ')).toBe('sk-abc123')
    expect(normalizeKey('"sk-abc123"')).toBe('sk-abc123')
    expect(normalizeKey('Bearer sk-abc123')).toBe('sk-abc123')
    expect(normalizeKey('sk-abc\u200B123')).toBe('sk-abc123')
  })
})

describe('looksLikeDeepSeekKey', () => {
  it('认得官方格式', () => {
    expect(looksLikeDeepSeekKey('sk-1234567890abcdefghij')).toBe(true)
  })

  it('明显不是密钥的会拦下来', () => {
    expect(looksLikeDeepSeekKey('hello')).toBe(false)
    expect(looksLikeDeepSeekKey('sk-短')).toBe(false)
    expect(looksLikeDeepSeekKey('')).toBe(false)
  })
})

describe('statusToKind', () => {
  it('把状态码翻译成可播报的错误类型', () => {
    expect(statusToKind(401)).toBe('auth')
    expect(statusToKind(402)).toBe('insufficient')
    expect(statusToKind(429)).toBe('rate_limit')
    expect(statusToKind(500)).toBe('server')
    expect(statusToKind(503)).toBe('server')
    expect(statusToKind(418)).toBe('unknown')
  })
})

describe('queryBalance 直连', () => {
  it('成功时返回结构化数据与耗时', async () => {
    const spy = mockFetch(() => jsonResponse(VALID_BODY))
    const outcome = await queryBalance('sk-1234567890abcdefghij')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('应当成功')
    expect(outcome.via).toBe('direct')
    expect(outcome.data.balance_infos[0]?.total_balance).toBe('110.00')
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)

    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe(BALANCE_ENDPOINT)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-1234567890abcdefghij')
  })

  it('401 归为密钥无效，并带出官方原话', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401))
    const outcome = await queryBalance('sk-1234567890abcdefghij')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('auth')
    expect(outcome.status).toBe(401)
    expect(outcome.upstreamMessage).toBe('Authentication Fails')
  })

  it('402 归为余额不足', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Insufficient Balance' } }, 402))
    const outcome = await queryBalance('sk-1234567890abcdefghij')
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('insufficient')
  })

  it('返回了 200 但不是余额结构 → malformed', async () => {
    mockFetch(() => jsonResponse({ hello: 'world' }))
    const outcome = await queryBalance('sk-1234567890abcdefghij')
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('malformed')
  })

  it('网络层直接抛错（CORS / 断网）→ network', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const outcome = await queryBalance('sk-1234567890abcdefghij')
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('network')
    expect(outcome.detail).toContain('Failed to fetch')
  })

  it('超时会主动放弃，而不是一直转圈', async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    const outcome = await queryBalance('sk-1234567890abcdefghij', { timeoutMs: 30 })
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('timeout')
  })

  it('用户主动取消 → aborted', async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const outcome = await queryBalance('sk-1234567890abcdefghij', {
      timeoutMs: 5000,
      signal: controller.signal,
    })
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('aborted')
  })

  it('空密钥不发请求', async () => {
    const spy = mockFetch(() => jsonResponse(VALID_BODY))
    const outcome = await queryBalance('   ')
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('empty')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('queryBalance 走本站代理', () => {
  it('解析代理信封，并在前端保持同样的数据结构', async () => {
    const spy = mockFetch(() => jsonResponse({ ok: true, status: 200, data: VALID_BODY }))
    const outcome = await queryBalance('sk-1234567890abcdefghij', { via: 'proxy' })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('应当成功')
    expect(outcome.via).toBe('proxy')

    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe('/api/balance')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ key: 'sk-1234567890abcdefghij' })
  })

  it('代理报错时沿用上游错误类型', async () => {
    mockFetch(() =>
      jsonResponse({ ok: false, status: 401, error: { kind: 'auth', message: 'Authentication Fails' } }, 401),
    )
    const outcome = await queryBalance('sk-1234567890abcdefghij', { via: 'proxy' })
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('auth')
    expect(outcome.status).toBe(401)
  })

  it('代理自身连不上上游 → proxy_failed', async () => {
    mockFetch(() =>
      jsonResponse({ ok: false, status: 502, error: { kind: 'proxy_failed', message: 'upstream unreachable' } }, 502),
    )
    const outcome = await queryBalance('sk-1234567890abcdefghij', { via: 'proxy' })
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('proxy_failed')
  })

  it('代理网络层失败（模拟被拦截）→ proxy_failed', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const outcome = await queryBalance('sk-1234567890abcdefghij', { via: 'proxy' })
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.kind).toBe('proxy_failed')
  })
})
