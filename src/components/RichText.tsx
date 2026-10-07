import type { ReactNode } from 'react'
import type { RichToken } from '../lib/markup'

/**
 * 把 token 序列渲染成 React 节点。
 * - 只渲染前 `revealed` 个 token，并在末尾接一个闪烁光标（打字机效果）
 * - 全部用 React 元素拼装，绝不使用 dangerouslySetInnerHTML
 */
export function RichText({ tokens, revealed }: { tokens: RichToken[]; revealed: number }): ReactNode {
  const nodes: ReactNode[] = []
  const visible = Math.max(0, Math.min(revealed, tokens.length))

  for (let i = 0; i < visible; i += 1) {
    const token = tokens[i]
    if (!token) continue

    switch (token.kind) {
      case 'link':
        nodes.push(
          <a
            key={i}
            className="rich__link"
            href={token.href}
            target="_blank"
            rel="noreferrer noopener"
            title={token.href}
          >
            {token.text}
          </a>,
        )
        break
      case 'code':
        nodes.push(
          <code key={i} className="rich__code">
            {token.text}
          </code>,
        )
        break
      case 'bold':
        nodes.push(
          <strong key={i} className="rich__strong">
            {token.text}
          </strong>,
        )
        break
      default:
        nodes.push(<span key={i}>{token.text}</span>)
    }
  }

  if (visible < tokens.length) {
    nodes.push(<span key="caret" className="caret" aria-hidden="true" />)
  }

  return <>{nodes}</>
}
