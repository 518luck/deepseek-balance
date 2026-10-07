import type { ReactNode } from 'react'
import {
  balanceSegments,
  type ActionsBlock,
  type BalanceBlock,
  type EstimateBlock,
  type TerminalAction,
} from '../lib/narrate'
import { currencyMeta, formatCompactCN, formatCount, formatMoney } from '../lib/format'
import { segmentRich } from '../lib/markup'
import { RichText } from './RichText'

/** 余额卡：大数字 + 构成比例条 + 图例 */
export function BalanceCard({ block }: { block: BalanceBlock }): ReactNode {
  const segments = balanceSegments(block)
  const meta = currencyMeta(block.currency)
  const hasTopUp = block.toppedUp > 0
  const hasGrant = block.granted > 0

  return (
    <div className={`balance ${block.available ? '' : 'balance--blocked'}`.trim()}>
      <div className="balance__head">
        <span className="balance__label">可用余额</span>
        <span className="balance__currency">{meta.name}</span>
      </div>

      <div className="balance__amount">{formatMoney(block.total, block.currency)}</div>

      <div className="balance__bar" role="img" aria-label={`充值 ${segments.toppedUp.toFixed(1)}%，赠送 ${segments.granted.toFixed(1)}%`}>
        {hasTopUp && (
          <span className="balance__seg balance__seg--topup" style={{ width: `${segments.toppedUp}%` }} />
        )}
        {hasGrant && (
          <span className="balance__seg balance__seg--grant" style={{ width: `${segments.granted}%` }} />
        )}
        {!hasTopUp && !hasGrant && <span className="balance__seg balance__seg--empty" style={{ width: '100%' }} />}
      </div>

      <ul className="balance__legend">
        <li>
          <span className="dot-key dot-key--topup" aria-hidden="true" />
          自己充值
          <strong>{formatMoney(block.toppedUp, block.currency)}</strong>
          <em>{segments.toppedUp.toFixed(0)}%</em>
        </li>
        <li>
          <span className="dot-key dot-key--grant" aria-hidden="true" />
          官方赠送
          <strong>{formatMoney(block.granted, block.currency)}</strong>
          <em>{segments.granted.toFixed(0)}%</em>
        </li>
      </ul>
    </div>
  )
}

/** 估算表：这笔钱大概还能撑多少 */
export function EstimateTable({ block }: { block: EstimateBlock }): ReactNode {
  const noteTokens = segmentRich(block.note)

  return (
    <div className="estimate">
      <table className="estimate__table">
        <thead>
          <tr>
            <th scope="col">模型</th>
            <th scope="col">约等于</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.modelId}>
              <th scope="row">
                <span className="estimate__model">{row.model}</span>
                <span className="estimate__blurb">{row.blurb}</span>
              </th>
              <td>
                <span className="estimate__rounds">
                  {formatCount(row.roundsLow)} ~ {formatCount(row.roundsHigh)} 轮对话
                </span>
                <span className="estimate__tokens">
                  或纯读入 {formatCompactCN(row.tokensLow)} ~ {formatCompactCN(row.tokensHigh)} tokens
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="estimate__note">
        <RichText tokens={noteTokens} revealed={noteTokens.length} />
      </p>
      <span className="estimate__currency">计价币种：{block.currency}</span>
    </div>
  )
}

/** 操作按钮组：重试直连 / 改用代理 / 强制查询 */
export function ActionRow({
  block,
  onAction,
  busy,
}: {
  block: ActionsBlock
  onAction: (action: TerminalAction) => void
  busy: boolean
}): ReactNode {
  return (
    <div className="actions">
      {block.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={`btn btn--ghost ${action.id === 'retry-proxy' ? 'btn--accent' : ''}`.trim()}
          onClick={() => onAction(action.id)}
          disabled={busy}
          title={action.hint}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
