import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useTerminalSession, type Phase, type SessionItem } from '../hooks/useTerminalSession'
import { normalizeKey } from '../lib/deepseek'
import { loadRememberedKey, loadRememberPref, saveRememberPref, saveRememberedKey } from '../lib/storage'
import type { TerminalAction } from '../lib/narrate'
import { ActionRow, BalanceCard, EstimateTable } from './Blocks'
import { RichText } from './RichText'

const IS_DEV = import.meta.env.DEV

const PHASE_LABEL: Record<Phase, string> = {
  idle: '就绪',
  connecting: '连接中',
  streaming: '输出中',
  done: '完成',
}

const DEMO_PATTERN = /^(?:demo|演示)(?:\s+([a-z0-9]+))?$/i

export function Terminal() {
  const session = useTerminalSession()
  const [value, setValue] = useState(() => loadRememberedKey())
  const [revealed, setRevealed] = useState(false)
  const [remember, setRemember] = useState(() => loadRememberPref())
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pinnedRef = useRef(true)

  const { items, phase, status, summary, busy, submit, present, runAction, skip, clear } = session

  /* 内容增长时自动贴底；用户手动往上翻时就不打扰 */
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !pinnedRef.current) return
    body.scrollTop = body.scrollHeight
  }, [items, status])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /* 连接阶段显示一个走动的耗时，避免“卡住了”的错觉 */
  useEffect(() => {
    if (phase !== 'connecting') {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => window.clearInterval(timer)
  }, [phase])

  /* ⌘/Ctrl + K 清屏：终端里的肌肉记忆 */
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        clear()
        setValue('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clear])

  const onScroll = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    pinnedRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 48
  }, [])

  const toggleRemember = useCallback(
    (next: boolean) => {
      setRemember(next)
      saveRememberPref(next)
      saveRememberedKey(next ? normalizeKey(value) : null)
    },
    [value],
  )

  const runDemo = useCallback(
    async (command: string) => {
      const { demoOutcome } = await import('../lib/demo')
      const arg = DEMO_PATTERN.exec(command)?.[1] ?? ''
      present(demoOutcome(arg))
    },
    [present],
  )

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const raw = value
      const trimmed = raw.trim()

      // 演示数据只在开发环境可用：生产构建里这段会被静态消除
      if (import.meta.env.DEV && DEMO_PATTERN.test(trimmed)) {
        void runDemo(trimmed)
        setValue('')
        return
      }

      if (trimmed) {
        setHistory((previous) => [raw, ...previous.filter((entry) => entry !== raw)].slice(0, 30))
        setHistoryIndex(-1)
      }
      if (remember && normalizeKey(raw)) saveRememberedKey(normalizeKey(raw))

      submit(raw)
      setValue('')
      inputRef.current?.focus()
    },
    [remember, runDemo, submit, value],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (busy) skip()
        else setValue('')
        return
      }
      if (event.key === 'ArrowUp' && history.length > 0) {
        event.preventDefault()
        const next = Math.min(historyIndex + 1, history.length - 1)
        setHistoryIndex(next)
        setValue(history[next] ?? '')
        return
      }
      if (event.key === 'ArrowDown' && historyIndex >= 0) {
        event.preventDefault()
        const next = historyIndex - 1
        setHistoryIndex(next)
        setValue(next < 0 ? '' : (history[next] ?? ''))
      }
    },
    [busy, history, historyIndex, skip],
  )

  const onBackdropClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('a, button, input, label, kbd')) return
    inputRef.current?.focus()
  }, [])

  const copySummary = useCallback(async () => {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(summary)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }, [summary])

  return (
    <section className="terminal glass" aria-label="DeepSeek 余额查询终端" onKeyDown={onKeyDown}>
      <header className="terminal__bar">
        <span className="terminal__dots" aria-hidden="true">
          <i className="dot dot--red" />
          <i className="dot dot--amber" />
          <i className="dot dot--green" />
        </span>
        <span className="terminal__title">deepseek-balance — 余额查询</span>
        <span className={`terminal__phase terminal__phase--${phase}`}>{PHASE_LABEL[phase]}</span>
      </header>

      <div
        className="terminal__body"
        ref={bodyRef}
        onScroll={onScroll}
        onClick={onBackdropClick}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {items.length === 0 && phase === 'idle' ? <Intro /> : null}

        {items.map((item) => (
          <SessionItemView key={item.id} item={item} onAction={runAction} busy={busy} />
        ))}

        {status ? <StatusLine label={status} elapsed={elapsed} /> : null}
      </div>

      <form className="terminal__form" onSubmit={onSubmit}>
        <label className="terminal__prompt" htmlFor="api-key" aria-hidden="true">
          ❯
        </label>
        <div className="field">
          <input
            id="api-key"
            ref={inputRef}
            className="field__input"
            type={revealed ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sk-… 粘贴 DeepSeek API Key"
            aria-label="DeepSeek API Key"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
          />
          {value ? (
            <button
              type="button"
              className="field__eye"
              onClick={() => setRevealed((current) => !current)}
              aria-label={revealed ? '隐藏密钥' : '显示密钥'}
            >
              {revealed ? '隐藏' : '显示'}
            </button>
          ) : null}
        </div>

        {phase === 'streaming' ? (
          <button type="button" className="btn btn--primary" onClick={skip}>
            跳过动画
          </button>
        ) : (
          <button type="submit" className="btn btn--primary" disabled={phase === 'connecting'}>
            {phase === 'connecting' ? '查询中…' : '查询余额'}
          </button>
        )}
      </form>

      <footer className="terminal__foot">
        <label className="remember">
          <input type="checkbox" checked={remember} onChange={(event) => toggleRemember(event.target.checked)} />
          <span>在此浏览器记住密钥</span>
        </label>

        <div className="terminal__hints">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 历史
          </span>
          <span>
            <kbd>Esc</kbd> 跳过动画
          </span>
          <span>
            <kbd>⌘</kbd>
            <kbd>K</kbd> 清屏
          </span>
          {summary ? (
            <button type="button" className="link-btn" onClick={() => void copySummary()}>
              {copied ? '已复制 ✓' : '复制摘要'}
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  )
}

function Intro() {
  return (
    <div className="intro">
      <p className="intro__line intro__line--accent">
        ✦ DeepSeek 余额查询终端
        <span className="intro__ver">v1.0</span>
      </p>
      <p className="intro__line">
        把 API Key 粘贴到下面，回车就开始查询。结果会像有人在你耳边打字一样，一个字一个字把余额交代清楚。
      </p>
      <p className="intro__line intro__line--dim">
        输入 <code>help</code> 看命令，输入 <code>about</code> 了解密钥是怎么被保护的。
      </p>
      {IS_DEV ? (
        <p className="intro__line intro__line--dev">
          开发模式：<code>demo</code> / <code>demo usd</code> / <code>demo multi</code> / <code>demo empty</code> /{' '}
          <code>demo 401</code> / <code>demo net</code> 播放演示数据
        </p>
      ) : null}
    </div>
  )
}

function StatusLine({ label, elapsed }: { label: string; elapsed: number }) {
  return (
    <p className="line line--dim line--status">
      <span className="spinner" aria-hidden="true" />
      {label}
      <span className="ellipsis" aria-hidden="true" />
      {elapsed > 300 ? <span className="status__time">{(elapsed / 1000).toFixed(1)}s</span> : null}
    </p>
  )
}

function SessionItemView({
  item,
  onAction,
  busy,
}: {
  item: SessionItem
  onAction: (action: TerminalAction) => void
  busy: boolean
}) {
  if (item.type === 'text') {
    return (
      <p className={`line line--${item.tone} ${item.typing ? 'line--typing' : ''}`.trim()}>
        <RichText tokens={item.tokens} revealed={item.revealed} />
      </p>
    )
  }

  const { block } = item
  if (block.kind === 'balance') {
    return (
      <div className="stack">
        <BalanceCard block={block} />
      </div>
    )
  }
  if (block.kind === 'estimate') {
    return (
      <div className="stack">
        <EstimateTable block={block} />
      </div>
    )
  }
  if (block.kind === 'actions') {
    return (
      <div className="stack">
        <ActionRow block={block} onAction={onAction} busy={busy} />
      </div>
    )
  }
  return <hr className="divider" />
}
