import type { QueryOutcome } from './deepseek'

/**
 * 仅开发环境使用的演示数据（生产构建里会被 tree-shaking 掉）。
 * 用于在没有真实 API Key 的情况下检查播报文案与动效。
 */
export function demoOutcome(arg: string): QueryOutcome {
  const base = { via: 'direct' as const, latencyMs: 268, fetchedAt: Date.now() }

  switch (arg) {
    case 'usd':
      return {
        ok: true,
        ...base,
        data: {
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '42.50', granted_balance: '0.00', topped_up_balance: '42.50' }],
        },
      }
    case 'multi':
      return {
        ok: true,
        ...base,
        data: {
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
            { currency: 'USD', total_balance: '3.20', granted_balance: '3.20', topped_up_balance: '0.00' },
          ],
        },
      }
    case 'empty':
      return {
        ok: true,
        ...base,
        data: {
          is_available: false,
          balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
        },
      }
    case '401':
      return { ok: false, ...base, kind: 'auth', status: 401, upstreamMessage: 'Authentication Fails' }
    case '402':
      return { ok: false, ...base, kind: 'insufficient', status: 402, upstreamMessage: 'Insufficient Balance' }
    case '500':
      return { ok: false, ...base, kind: 'server', status: 503, upstreamMessage: 'Service is too busy' }
    case 'net':
      return { ok: false, ...base, kind: 'network', detail: 'TypeError: Failed to fetch' }
    case 'timeout':
      return { ok: false, ...base, kind: 'timeout' }
    case 'gift':
      return {
        ok: true,
        ...base,
        data: {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '9.86', granted_balance: '9.86', topped_up_balance: '0.00' }],
        },
      }
    default:
      return {
        ok: true,
        ...base,
        data: {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
        },
      }
  }
}
