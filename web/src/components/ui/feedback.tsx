import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { T } from "../../../../shared/i18n.ts"
import { cx } from "../../lib/hooks"
import { Button } from "./controls"
import { Icon, type IconName } from "./icon"

export function Empty({ icon = "server", title, detail, action, onAction, error, secondary, onSecondary, compact }: {
  icon?: IconName
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
  onAction?: () => void
  error?: boolean
  secondary?: ReactNode
  onSecondary?: () => void
  compact?: boolean
}) {
  return (
    <div className={cx("empty", error && "is-error", compact && "empty-compact")} role={error ? "alert" : undefined}>
      <span className="empty-icon"><Icon name={error ? "triangle-alert" : icon} size={20} /></span>
      <p className="empty-title">{title}</p>
      {detail && <p className="empty-detail">{detail}</p>}
      {(action || secondary) && (
        <div className="empty-actions">
          {secondary && <Button onClick={onSecondary}>{secondary}</Button>}
          {action && <Button kind={error ? "secondary" : "primary"} icon={error ? "refresh-cw" : undefined} onClick={onAction}>{action}</Button>}
        </div>
      )}
    </div>
  )
}

export function Notice({ tone = "info", icon, children, action }: { tone?: "info" | "warn" | "bad"; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="notice" data-tone={tone} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon || (tone === "bad" ? "triangle-alert" : tone === "warn" ? "circle-alert" : "info")} />
      <div className="notice-text">{children}</div>
      {action}
    </div>
  )
}

export function Skeleton({ className, style, label }: { className?: string; style?: CSSProperties; label?: string }) {
  return <div className={cx("skeleton", className)} style={style} role={label ? "status" : undefined} aria-label={label}></div>
}

// Toasts: one live region, newest last, each dismissing itself.
type Toast = { id: number; text: string; tone: "ok" | "bad" | "info" }
const store = { items: [] as Toast[], listeners: new Set<(items: Toast[]) => void>(), seq: 0 }

export function toast(text: string, tone: Toast["tone"] = "ok") {
  const id = ++store.seq
  store.items = [...store.items, { id, text, tone }].slice(-3)
  store.listeners.forEach((fn) => fn(store.items))
  setTimeout(() => {
    store.items = store.items.filter((t) => t.id !== id)
    store.listeners.forEach((fn) => fn(store.items))
  }, 3200)
}

export function Toasts() {
  const [items, setItems] = useState(store.items)
  useEffect(() => {
    store.listeners.add(setItems)
    return () => {
      store.listeners.delete(setItems)
    }
  }, [])
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          <Icon name={t.tone === "bad" ? "circle-alert" : t.tone === "info" ? "info" : "circle-check"} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export async function copyText(text: string, done = T("已复制")) {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
    return true
  } catch {
    toast(T("无法访问剪贴板，请手动选择并复制"), "bad")
    return false
  }
}

/**
 * A value with its copy control beside it; the control shows on hover and
 * focus, and stays faintly visible on touch screens.
 */
export function CopyValue({ value, label, empty, mono = true, className }: { value?: string | null; label: string; empty?: ReactNode; mono?: boolean; className?: string }) {
  const [done, setDone] = useState(false)
  if (!value) return <span className={cx("copy-value is-empty", className)}>{empty ?? T("未上报")}</span>
  return (
    <span className={cx("copy-value", mono && "mono", className)}>
      <span className="copy-text">{value}</span>
      <button
        type="button"
        className="copy-button"
        aria-label={T("复制{label}", { label })}
        onClick={async (e) => {
          e.stopPropagation()
          if (await copyText(value)) {
            setDone(true)
            setTimeout(() => setDone(false), 1400)
          }
        }}
      >
        <Icon name={done ? "check" : "copy"} size={14} />
      </button>
    </span>
  )
}

/** A block of command text with its own copy action. */
export function CodeBlock({ code, label, disabled, empty }: { code: string; label: ReactNode; disabled?: boolean; empty?: ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    <div className={cx("code-block", disabled && "is-disabled")}>
      <pre>{disabled ? empty : code}</pre>
      {!disabled && (
        <Button
          size="sm"
          icon={done ? "check" : "copy"}
          onClick={async () => {
            if (await copyText(code)) {
              setDone(true)
              setTimeout(() => setDone(false), 1600)
            }
          }}
        >
          {done ? T("已复制") : label}
        </Button>
      )}
    </div>
  )
}
