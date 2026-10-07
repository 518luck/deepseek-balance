/**
 * Cloudflare Worker
 *
 * 1. 静态资源：前端构建产物由 Cloudflare 的静态资源层直接响应（见 wrangler.jsonc）
 * 2. /api/balance：可选的余额代理 —— 只在浏览器直连被网络策略拦截、且用户主动点击
 *    「用本站代理重试」时才会走到这里。
 *
 * 隐私约定：密钥只用于这一次转发，不写日志、不落盘、不回显。
 */

interface Env {
  ASSETS: { fetch(input: Request): Promise<Response> }
}

const UPSTREAM = 'https://api.deepseek.com/user/balance'
const MAX_BODY_BYTES = 4096
const UPSTREAM_TIMEOUT_MS = 12_000
const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,}$/

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  })
}

function kindForStatus(status: number): string {
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

async function handleBalance(request: Request): Promise<Response> {
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return json({ ok: false, status: 400, error: { kind: 'bad_request', message: 'unreadable body' } }, 400)
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return json({ ok: false, status: 413, error: { kind: 'bad_request', message: 'body too large' } }, 413)
  }

  let key = ''
  try {
    const parsed = JSON.parse(rawBody) as { key?: unknown }
    key = typeof parsed?.key === 'string' ? parsed.key.trim() : ''
  } catch {
    return json({ ok: false, status: 400, error: { kind: 'bad_request', message: 'invalid json body' } }, 400)
  }

  if (!KEY_PATTERN.test(key)) {
    return json({ ok: false, status: 400, error: { kind: 'bad_request', message: 'invalid key format' } }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    return json(
      {
        ok: false,
        status: 502,
        error: {
          kind: 'proxy_failed',
          message: error instanceof Error ? error.message : 'upstream unreachable',
        },
      },
      502,
    )
  }

  const text = await upstream.text()

  if (!upstream.ok) {
    let message = text.slice(0, 200)
    let type: string | undefined
    let code: string | undefined
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; type?: string; code?: string } }
      message = parsed?.error?.message ?? message
      type = parsed?.error?.type
      code = parsed?.error?.code
    } catch {
      /* 上游不是 JSON，就保留截断后的原文 */
    }
    return json(
      { ok: false, status: upstream.status, error: { kind: kindForStatus(upstream.status), message, type, code } },
      upstream.status,
    )
  }

  try {
    const data = JSON.parse(text) as unknown
    // 不做任何字段解释，原样交给前端；前端负责翻译成人话
    return json({ ok: true, status: 200, data })
  } catch {
    return json({ ok: false, status: 502, error: { kind: 'malformed', message: 'upstream returned non-json' } }, 502)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/balance') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } })
      }
      if (request.method !== 'POST') {
        return json({ ok: false, status: 405, error: { kind: 'bad_request', message: 'use POST' } }, 405)
      }
      return handleBalance(request)
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ ok: false, status: 404, error: { kind: 'bad_request', message: 'not found' } }, 404)
    }

    return env.ASSETS.fetch(request)
  },
}
