/**
 * DeepSeek 余额接口的原始数据结构。
 *
 * 注意：这里的字段名只用于“解析”接口响应，
 * UI 上永远不会把这些下划线字段直接展示给用户（见 lib/narrate.ts）。
 */

/** GET https://api.deepseek.com/user/balance 的单个币种余额 */
export interface BalanceInfo {
  /** 币种，官方目前为 CNY / USD */
  currency: string
  /** 总可用余额 = 充值余额 + 未过期的赠送余额 */
  total_balance: string
  /** 尚未过期的赠送余额 */
  granted_balance: string
  /** 自己充值的余额 */
  topped_up_balance: string
}

/** GET https://api.deepseek.com/user/balance 的响应体 */
export interface BalanceResponse {
  /** 余额是否足够发起 API 调用 */
  is_available: boolean
  /** 各币种余额明细，可能为空数组 */
  balance_infos: BalanceInfo[]
}

/** 运行时校验：确认拿到的是余额响应，而不是别的 JSON */
export function isBalanceResponse(value: unknown): value is BalanceResponse {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.is_available !== 'boolean') return false
  if (!Array.isArray(candidate.balance_infos)) return false
  return candidate.balance_infos.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const info = item as Record<string, unknown>
    return (
      typeof info.currency === 'string' &&
      typeof info.total_balance === 'string' &&
      typeof info.granted_balance === 'string' &&
      typeof info.topped_up_balance === 'string'
    )
  })
}
