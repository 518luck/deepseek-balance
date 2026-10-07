import {
  CONSOLE_KEYS_URL,
  DIRECT_TIMEOUT_MS,
  TOPUP_URL,
  type ErrorKind,
  type QueryFailure,
  type QuerySuccess,
} from './deepseek'
import {
  formatCompactCN,
  formatLatency,
  formatLocalTime,
  formatMoney,
  formatRounds,
  percentOf,
  truncate,
} from './format'
import { PRICING_SOURCE, PRICING_VERIFIED_ON, TYPICAL_ROUND, estimateUsage, type EstimateRow } from './pricing'

/* ------------------------------------------------------------------ *
 * 播报模型：narrate*() 只负责“把数据翻译成人话”，
 * 真正逐字打印的节奏由 hooks/useTerminalSession.ts 控制。
 * ------------------------------------------------------------------ */

export type Tone = 'info' | 'ok' | 'warn' | 'error' | 'dim' | 'accent'

export type TerminalAction = 'retry-direct' | 'retry-proxy' | 'force-shape'

export interface ActionSpec {
  id: TerminalAction
  label: string
  hint?: string
}

export interface TextBlock {
  kind: 'text'
  id: string
  tone: Tone
  text: string
  /** 打完这行之后额外停顿的毫秒数 */
  pause?: number
}

export interface BalanceBlock {
  kind: 'balance'
  id: string
  currency: string
  total: number
  granted: number
  toppedUp: number
  /** 官方给出的“是否够用”判断 */
  available: boolean
}

export interface EstimateBlock {
  kind: 'estimate'
  id: string
  currency: string
  rows: EstimateRow[]
  note: string
}

export interface ActionsBlock {
  kind: 'actions'
  id: string
  actions: ActionSpec[]
}

export interface DividerBlock {
  kind: 'divider'
  id: string
}

export type Block = TextBlock | BalanceBlock | EstimateBlock | ActionsBlock | DividerBlock

export interface NarrationPlan {
  blocks: Block[]
  /** 纯文本摘要，用于「复制摘要」按钮 */
  summary: string
}

const VIA_NOTE: Record<'direct' | 'proxy', string> = {
  direct: '本次查询方式：浏览器直连 api.deepseek.com，你的密钥没有经过本站服务器。',
  proxy: '本次查询方式：经本站 Cloudflare 边缘函数转发，密钥仅用于这一次请求，不记录、不落盘。',
}

function createBuilder() {
  let seq = 0
  const blocks: Block[] = []
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`

  return {
    blocks,
    text(tone: Tone, text: string, pause?: number) {
      blocks.push({ kind: 'text', id: nextId('t'), tone, text, pause })
    },
    balance(data: Omit<BalanceBlock, 'kind' | 'id'>) {
      blocks.push({ kind: 'balance', id: nextId('b'), ...data })
    },
    estimate(data: Omit<EstimateBlock, 'kind' | 'id'>) {
      blocks.push({ kind: 'estimate', id: nextId('e'), ...data })
    },
    actions(actions: ActionSpec[]) {
      blocks.push({ kind: 'actions', id: nextId('a'), actions })
    },
    divider() {
      blocks.push({ kind: 'divider', id: nextId('d') })
    },
  }
}

const ACTION_COPY: Record<TerminalAction, ActionSpec> = {
  'retry-direct': { id: 'retry-direct', label: '再查一次（浏览器直连）' },
  'retry-proxy': { id: 'retry-proxy', label: '用本站代理重试', hint: '密钥仅用于这次转发' },
  'force-shape': { id: 'force-shape', label: '我知道风险，强制查询' },
}

function action(...ids: TerminalAction[]): ActionSpec[] {
  return ids.map((id) => ACTION_COPY[id])
}

/** 备注：金额为 0 时不要输出“其中 ¥0.00 …”这类废话 */
function breakdownSentence(total: number, granted: number, toppedUp: number, currency: string): string | null {
  const money = (v: number) => formatMoney(v, currency)
  const hasGrant = granted > 0
  const hasTopUp = toppedUp > 0

  if (total <= 0) return '这个币种下暂时没有任何余额。'
  if (hasGrant && hasTopUp) {
    return `其中 ${money(toppedUp)} 是你自己充值的，${money(granted)} 是 DeepSeek 赠送的额度 —— 扣费时赠送部分会先被用掉。`
  }
  if (hasTopUp) return `这笔余额（${money(total)}）全部来自你的充值，目前没有可用的赠送额度。`
  if (hasGrant) return `这笔余额（${money(total)}）全部是 DeepSeek 赠送的额度，扣费时会先从这里面扣。`
  return null
}

/** 成功拿到余额：翻译成人话 */
export function narrateSuccess(outcome: QuerySuccess): NarrationPlan {
  const { data } = outcome
  const out = createBuilder()
  const infos = data.balance_infos.map((info) => ({
    currency: info.currency,
    total: Number.parseFloat(info.total_balance) || 0,
    granted: Number.parseFloat(info.granted_balance) || 0,
    toppedUp: Number.parseFloat(info.topped_up_balance) || 0,
  }))

  out.text('dim', `收到 api.deepseek.com 的回复了（耗时 ${formatLatency(outcome.latencyMs)}）。`)

  if (data.is_available) {
    out.text('ok', '账户状态：正常，现在可以继续调用 DeepSeek API。')
  } else {
    out.text('warn', '账户状态：余额不足，新的 API 调用会被拒绝 —— 需要充值才能恢复。')
  }

  if (infos.length === 0) {
    out.text(
      'warn',
      '不过接口没有给出任何余额明细，建议到控制台核对一下账户状态：[打开 DeepSeek 控制台](https://platform.deepseek.com/usage)。',
    )
  }

  if (infos.length > 1) {
    out.text('info', `你的账户里有 ${infos.length} 个币种的余额，我逐个说：`)
  }

  infos.forEach((info) => {
    out.balance({
      currency: info.currency,
      total: info.total,
      granted: info.granted,
      toppedUp: info.toppedUp,
      available: data.is_available,
    })
    const sentence = breakdownSentence(info.total, info.granted, info.toppedUp, info.currency)
    if (sentence) out.text('dim', sentence)
  })

  const spendable = infos.filter((info) => info.total > 0)
  if (spendable.length > 0) {
    out.text('info', '按官网当前牌价粗算，这些余额大概还能撑这么多：')
    spendable.forEach((info) => {
      const rows = estimateUsage(info.total, info.currency)
      if (!rows || rows.length === 0) return
      out.estimate({
        currency: info.currency,
        rows,
        note: `估算假设：每轮对话 ${formatCompactCN(TYPICAL_ROUND.inputTokens)} tokens 输入 + ${formatCompactCN(
          TYPICAL_ROUND.outputTokens,
        )} tokens 输出（按未命中缓存计价），高峰期与空闲时段的价格差一倍。真实用量因人而异，价格以 [官方定价页](${PRICING_SOURCE}) 为准（本表核对于 ${PRICING_VERIFIED_ON}）。`,
      })
    })
  } else if (data.is_available) {
    out.text('dim', '余额为 0，暂时算不出还能用多久。')
  }

  if (!data.is_available || infos.every((info) => info.total <= 0)) {
    out.text('warn', `充值入口在这里：[前往 DeepSeek 充值](${TOPUP_URL})。`)
  } else if (infos.some((info) => info.total > 0 && info.total < 5)) {
    out.text('dim', '余额已经不多了，建议顺手充点值，免得用到一半被中断。')
  }

  out.divider()
  out.text('dim', `查询时间 ${formatLocalTime(outcome.fetchedAt)}（本地时间）· 本站不缓存、不记录任何数据。`)
  out.text('dim', VIA_NOTE[outcome.via])
  out.text('dim', '小提示：↑ 可以找回上一次的密钥，输入 help 查看全部命令。')

  const primary = infos[0]
  const primaryEstimate = primary ? estimateUsage(primary.total, primary.currency)?.[0] : null
  const summaryLines = [
    `DeepSeek 余额（${formatLocalTime(outcome.fetchedAt)}）`,
    ...infos.map(
      (info) =>
        `${formatMoney(info.total, info.currency)} = 充值 ${formatMoney(info.toppedUp, info.currency)} + 赠送 ${formatMoney(
          info.granted,
          info.currency,
        )}`,
    ),
    data.is_available ? '状态：可正常调用 API' : '状态：余额不足，需充值',
  ]
  if (primary && primaryEstimate) {
    summaryLines.push(
      `粗算可用：${primaryEstimate.model} 约 ${formatRounds(primaryEstimate.roundsLow)} ~ ${formatRounds(
        primaryEstimate.roundsHigh,
      )} 轮典型对话`,
    )
  }

  return { blocks: out.blocks, summary: summaryLines.join('\n') }
}

const FAILURE_COPY: Record<ErrorKind, { tone: Tone; headline: (f: QueryFailure) => string; hints: string[] }> = {
  empty: {
    tone: 'warn',
    headline: () => '还没填 API Key 呢 —— 在下面粘贴一串密钥再回车就行。',
    hints: [`密钥在 [DeepSeek 控制台 → API Keys](${CONSOLE_KEYS_URL}) 创建，形如 sk-xxxxxxxx。`],
  },
  shape: {
    tone: 'warn',
    headline: () => '这串内容看起来不太像 DeepSeek 的 API Key（官方密钥一般以 sk- 开头，长度 30 位以上）。',
    hints: [
      '可能是复制时漏了一截，或者复制成了别的平台的密钥。',
      '如果你确认它没问题（比如官方改了格式），也可以强制查一次。',
    ],
  },
  auth: {
    tone: 'error',
    headline: () => '密钥无效：DeepSeek 拒绝了这次查询。',
    hints: [
      '常见原因：密钥复制不完整、密钥已在控制台被删除、或账号状态异常。',
      `到 [控制台](${CONSOLE_KEYS_URL}) 重新生成一个密钥，再试一次。`,
    ],
  },
  insufficient: {
    tone: 'warn',
    headline: () => '余额已经用完了：充值和赠送额度都已耗尽，新的 API 调用会被拒绝。',
    hints: [`充值后即可恢复：[前往 DeepSeek 充值](${TOPUP_URL})。`],
  },
  rate_limit: {
    tone: 'warn',
    headline: () => '请求太频繁，DeepSeek 临时限流了。',
    hints: ['等几秒钟再试即可；余额查询本身不消耗 token。'],
  },
  bad_request: {
    tone: 'error',
    headline: (f) => `请求被拒绝（接口返回 ${f.status ?? '4xx'}）。`,
    hints: ['这通常是本站的解析或参数有问题，不是你密钥的锅，稍后再试一次。'],
  },
  server: {
    tone: 'error',
    headline: (f) => `DeepSeek 服务端暂时不可用（接口返回 ${f.status ?? '5xx'}）。`,
    hints: ['和你密钥无关，属于官方侧波动，过一会儿再来。'],
  },
  network: {
    tone: 'error',
    headline: () => '连不上 api.deepseek.com —— 请求在浏览器这一层就失败了。',
    hints: [
      '常见原因：网络或公司代理拦截、浏览器扩展（广告拦截 / 隐私插件）、所在网络禁止访问该域名。',
      '检查网络后可以再试一次；或者让本站的 Cloudflare 边缘函数替你转发这一次查询 —— 密钥只用于转发，不记录、不落盘。',
    ],
  },
  timeout: {
    tone: 'warn',
    headline: () => `等太久没有回应（超过 ${Math.round(DIRECT_TIMEOUT_MS / 1000)} 秒），已经放弃这次查询。`,
    hints: ['通常意味着网络太慢或被防火墙挂住了，可以重试一次。'],
  },
  aborted: {
    tone: 'dim',
    headline: () => '这次查询已经取消。',
    hints: [],
  },
  malformed: {
    tone: 'error',
    headline: () => '收到了回复，但内容不是余额数据。',
    hints: [
      '可能是接口做了调整，也可能是网络中间设备返回了别的页面。',
      '如果每次都这样，说明本站需要更新解析逻辑了。',
    ],
  },
  proxy_failed: {
    tone: 'error',
    headline: () => '本站的边缘代理没能完成这次转发。',
    hints: ['可能代理被网络策略拦截，或上游返回了异常。建议改回「浏览器直连」再试一次。'],
  },
  proxy_missing: {
    tone: 'warn',
    headline: () => '这个站点没有部署边缘代理，所以「代理重试」这条路走不通。',
    hints: [
      '本站是纯静态部署，少了一个 /api/balance 边缘函数（浏览器直连不受影响，它本来就不需要服务器）。',
      '下面点「再查一次（浏览器直连）」即可 —— 如果直连被网络拦截，那就得换网络或关掉拦截插件。',
    ],
  },
  unknown: {
    tone: 'error',
    headline: (f) => `查询失败了，但原因不明${f.status ? `（接口返回 ${f.status}）` : ''}。`,
    hints: ['可以重试一次；如果一直失败，把这次的时间点记下来反馈给我。'],
  },
}

const FAILURE_ACTIONS: Partial<Record<ErrorKind, TerminalAction[]>> = {
  shape: ['force-shape'],
  auth: ['retry-direct'],
  rate_limit: ['retry-direct'],
  bad_request: ['retry-direct'],
  server: ['retry-direct'],
  network: ['retry-proxy', 'retry-direct'],
  timeout: ['retry-direct'],
  malformed: ['retry-direct'],
  proxy_failed: ['retry-direct', 'retry-proxy'],
  proxy_missing: ['retry-direct'],
  unknown: ['retry-direct'],
}

/** 查询失败：同样翻译成人话，并给出下一步能做什么 */
export function narrateFailure(failure: QueryFailure): NarrationPlan {
  const copy = FAILURE_COPY[failure.kind]
  const out = createBuilder()

  out.text(copy.tone, copy.headline(failure))

  for (const hint of copy.hints) out.text('dim', hint)

  if (failure.upstreamMessage && failure.kind !== 'malformed') {
    out.text('dim', `官方原话：${truncate(failure.upstreamMessage, 120)}`)
  }
  if (failure.detail && failure.kind !== 'malformed') {
    out.text('dim', `技术细节：${truncate(failure.detail, 120)}`)
  }
  if (failure.kind !== 'empty' && failure.kind !== 'aborted' && failure.kind !== 'shape') {
    out.text('dim', VIA_NOTE[failure.via])
  }

  const actions = FAILURE_ACTIONS[failure.kind]
  if (actions && actions.length > 0) out.actions(action(...actions))

  const headline = copy.headline(failure)
  return {
    blocks: out.blocks,
    summary: [headline, ...copy.hints].join('\n'),
  }
}

/** help 命令 */
export function narrateHelp(): NarrationPlan {
  const out = createBuilder()
  out.text('info', '我是这个页面里的小终端，能帮你查 DeepSeek 账户余额。')
  out.text('dim', '直接粘贴 API Key 并回车 → 查询余额（这是我唯一真正干的事）')
  out.text('dim', 'clear         清屏，重新来过')
  out.text('dim', 'about         这个网站怎么工作、密钥安不安全')
  out.text('dim', 'help          再看一遍这份说明')
  out.text('info', '快捷键')
  out.text('dim', '↑ / ↓         翻看历史输入')
  out.text('dim', 'Esc           跳过打字动画，立刻看全文')
  out.text('dim', '⌘/Ctrl + K    清屏')
  return { blocks: out.blocks, summary: 'DeepSeek 余额查询终端：粘贴 API Key 回车即可查询。' }
}

/** about 命令 */
export function narrateAbout(): NarrationPlan {
  const out = createBuilder()
  out.text('info', '这个网站做什么？')
  out.text(
    'dim',
    '读取你的 DeepSeek 账户余额，然后把接口返回的字段翻译成正常人话：还剩多少钱、钱从哪来、大概还能聊多少轮。',
  )
  out.text('info', '密钥安全吗？')
  out.text(
    'dim',
    '默认走「浏览器直连」：密钥由你的浏览器直接发往 api.deepseek.com，本站服务器看不到它，也不写入任何持久存储（除非你主动勾选「记住密钥」）。',
  )
  out.text(
    'dim',
    '只有在直连失败、并且你手动点了「用本站代理重试」时，密钥才会经本站 Cloudflare 边缘函数转发一次：仅用于转发，不记录、不落盘。',
  )
  out.text('info', '数据从哪来？')
  out.text(
    'dim',
    `官方余额接口 \`GET /user/balance\`（只读，不消耗 token）：${'https://api.deepseek.com/user/balance'}`,
  )
  out.text('info', '余额能干嘛？')
  out.text(
    'dim',
    `余额按 token 计费，价格随模型和时段浮动。点这里看 [官方定价页](${PRICING_SOURCE})。`,
  )
  return {
    blocks: out.blocks,
    summary: '本站用浏览器直连 DeepSeek 官方余额接口，密钥不经过服务器。',
  }
}

export function narrateUnknownCommand(command: string): NarrationPlan {
  const out = createBuilder()
  out.text('warn', `没听过 \`${truncate(command, 24)}\` 这个命令。`)
  out.text('dim', '我只会查余额：直接粘贴 API Key 回车就行；输入 help 看看全部命令。')
  return { blocks: out.blocks, summary: '未识别的命令。' }
}

/** 余额构成条的百分比（充值 / 赠送两段） */
export function balanceSegments(block: BalanceBlock): { toppedUp: number; granted: number } {
  return {
    toppedUp: percentOf(block.toppedUp, block.total),
    granted: percentOf(block.granted, block.total),
  }
}
