import { isBalanceResponse, type BalanceResponse } from './types'

/** 官方余额接口（GET，Bearer 鉴权） */
export const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
/** 本站的边缘代理（仅在用户明确选择“代理重试”时使用） */
export const PROXY_ENDPOINT = '/api/balance'
/** 控制台：创建 / 管理 API Key */
export const CONSOLE_KEYS_URL = 'https://platform.deepseek.com/api_keys'
/** 控制台：充值 */
export const TOPUP_URL = 'https://platform.deepseek.com/top_up'
/** 余额接口属于轻量调用，正常都在 1 秒内返回 */
export const DIRECT_TIMEOUT_MS = 15_000
export const PROXY_TIMEOUT_MS = 20_000

export type Via = 'direct' | 'proxy'

export type ErrorKind =
  | 'empty'
  | 'shape'
  | 'auth'
  | 'insufficient'
  | 'rate_limit'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'malformed'
  | 'proxy_failed'
  | 'proxy_missing'
  | 'unknown'

export interface QuerySuccess {
  ok: true
  via: Via
  latencyMs: number
  fetchedAt: number
  data: BalanceResponse
}

export interface QueryFailure {
  ok: false
  via: Via
  latencyMs: number
  fetchedAt: number
  kind: ErrorKind
  /** HTTP 状态码（如果有） */
  status?: number
  /** 官方返回的原始错误文案，仅用于附加说明 */
  upstreamMessage?: string
  /** 网络层异常信息（例如 Failed to fetch） */
  detail?: string
}

export type QueryOutcome = QuerySuccess | QueryFailure

export interface QueryOptions {
  via?: Via
  signal?: AbortSignal
  timeoutMs?: number
}

/** 清掉复制粘贴常见的杂质：首尾空白、零宽字符、包裹的引号、误带的 Bearer 前缀 */
export function normalizeKey(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^bearer\s+/i, '')
    .replace(/\s+/g, '')
}

/**
 * 官方密钥形如 sk-xxxxxxxx（32 位左右）。
 * 这里只是“像不像”的提示，不做硬拦截 —— 格式变了也要让用户能查。
 */
export function looksLikeDeepSeekKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(key)
}

export function statusToKind(status: number): ErrorKind {
  switch (status) {
    case 400:
    case 422:
      return 'bad_request'
    case 401:
    case 403:
      return 'auth'
    case 402:
      return 'insufficient'
    case 429:
      return 'rate_limit'
    case 500:
    case 502:
    case 503:
    case 504:
      return 'server'
    default:
      return status >= 500 ? 'server' : 'unknown'
  }
}

interface ProxyEnvelope {
  ok?: boolean
  status?: number
  data?: unknown
  error?: { kind?: string; message?: string; type?: string; code?: string } | null
}

const ERROR_KINDS: readonly ErrorKind[] = [
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

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value)
}

function safeJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function pickUpstreamMessage(parsed: unknown, fallbackText: string): string | undefined {
  if (typeof parsed === 'object' && parsed !== null) {
    const body = parsed as Record<string, unknown>
    const error = body.error
    if (typeof error === 'object' && error !== null) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) return message.trim()
    }
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim()
  }
  const fallback = fallbackText.replace(/\s+/g, ' ').trim()
  return fallback ? fallback.slice(0, 200) : undefined
}

function errorText(error: unknown): string | undefined {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  return undefined
}

function failure(
  partial: Omit<QueryFailure, 'ok' | 'fetchedAt'>,
): QueryFailure {
  return { ok: false, fetchedAt: Date.now(), ...partial }
}

/**
 * 查询余额。
 *
 * - `via: 'direct'`：浏览器直连 api.deepseek.com，密钥不经过任何第三方（默认，推荐）
 * - `via: 'proxy'` ：经本站 CF 边缘函数转发，用于直连被网络策略拦截时的兜底
 */
export async function queryBalance(key: string, options: QueryOptions = {}): Promise<QueryOutcome> {
  const via: Via = options.via ?? 'direct'
  const cleaned = normalizeKey(key)
  const startedAt = Date.now()

  if (!cleaned) {
    return failure({ via, latencyMs: 0, kind: 'empty' })
  }

  const timeoutMs = options.timeoutMs ?? (via === 'direct' ? DIRECT_TIMEOUT_MS : PROXY_TIMEOUT_MS)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const relayAbort = () => controller.abort()
  options.signal?.addEventListener('abort', relayAbort)

  try {
    const response =
      via === 'direct'
        ? await fetch(BALANCE_ENDPOINT, {
            method: 'GET',
            headers: { Authorization: `Bearer ${cleaned}`, Accept: 'application/json' },
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          })
        : await fetch(PROXY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ key: cleaned }),
            signal: controller.signal,
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          })

    const latencyMs = Date.now() - startedAt
    const text = await response.text()
    const parsed = safeJson(text)

    if (via === 'proxy') {
      const envelope = (parsed ?? {}) as ProxyEnvelope
      if (response.ok && envelope.ok && isBalanceResponse(envelope.data)) {
        return { ok: true, via, latencyMs, fetchedAt: Date.now(), data: envelope.data }
      }
      const status = typeof envelope.status === 'number' ? envelope.status : response.status
      // 404 = 这个站根本没部署 /api/balance（例如只把 dist 拖到网页端做纯静态部署）
      const kind: ErrorKind =
        response.status === 404
          ? 'proxy_missing'
          : // 代理会带上自己判断好的错误类型，优先采信；否则按状态码推断
            isErrorKind(envelope.error?.kind)
            ? envelope.error.kind
            : statusToKind(status || response.status || 0)
      return failure({
        via,
        latencyMs,
        kind,
        status,
        upstreamMessage: envelope.error?.message ?? pickUpstreamMessage(parsed, text),
        detail: envelope.error?.type ?? envelope.error?.code,
      })
    }

    if (!response.ok) {
      return failure({
        via,
        latencyMs,
        kind: statusToKind(response.status),
        status: response.status,
        upstreamMessage: pickUpstreamMessage(parsed, text),
      })
    }

    if (!isBalanceResponse(parsed)) {
      return failure({
        via,
        latencyMs,
        kind: 'malformed',
        status: response.status,
        detail: text.slice(0, 120),
      })
    }

    return { ok: true, via, latencyMs, fetchedAt: Date.now(), data: parsed }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    if (timedOut) return failure({ via, latencyMs, kind: 'timeout' })
    if (options.signal?.aborted) return failure({ via, latencyMs, kind: 'aborted' })
    return failure({
      via,
      latencyMs,
      kind: via === 'direct' ? 'network' : 'proxy_failed',
      detail: errorText(error),
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}
