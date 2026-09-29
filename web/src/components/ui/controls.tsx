import {
  Children, cloneElement, forwardRef, isValidElement, useId, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactElement, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react"

import { T } from "../../../../shared/i18n.ts"
import { cx } from "../../lib/hooks"
import { Icon, type IconName } from "./icon"

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: "primary" | "secondary" | "ghost" | "danger" | "danger-ghost"
  size?: "sm"
  icon?: IconName
  iconAfter?: IconName
  busy?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { kind = "secondary", size, icon, iconAfter, busy, className, children, type = "button", disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", `btn-${kind}`, size && `btn-${size}`, busy && "is-busy", className)}
      aria-busy={busy || undefined}
      {...rest}
      disabled={disabled || busy}
    >
      {busy ? <Icon name="loader-circle" className="spin" /> : icon && <Icon name={icon} />}
      {children && <span className="btn-label">{children}</span>}
      {iconAfter && <Icon name={iconAfter} />}
    </button>
  )
})

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  icon: IconName
  kind?: "ghost" | "secondary" | "primary" | "danger-ghost"
  tip?: "bottom" | "left" | "top"
}

/** An icon-only control. Its accessible name is also the tooltip it shows. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, kind = "ghost", className, tip = "bottom", ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={cx("btn", `btn-${kind}`, "btn-icon", className)} aria-label={label} data-tip={tip} {...rest}>
      <Icon name={icon} />
      <span className="tip" aria-hidden="true">{label}</span>
    </button>
  )
})

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

/**
 * Label above, one message line below that holds the hint or, in its place, the
 * error, so a refusal never moves the controls around it.
 */
export function Field({ label, hint, error, children, className, optional, inline }: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>
  className?: string
  optional?: boolean
  inline?: boolean
}) {
  const id = useId()
  const child = Children.only(children)
  const control = child.props.id || `${id}-control`
  const messageId = `${id}-message`
  const enhanced = isValidElement(child)
    ? cloneElement(child, { id: control, "aria-describedby": hint || error ? messageId : undefined, "aria-invalid": error ? true : undefined })
    : child
  return (
    <div className={cx("field", error && "has-error", inline && "field-inline", className)}>
      <label className="field-label" htmlFor={control}>
        <span>{label}</span>
        {optional && <span className="field-optional">{T("可选")}</span>}
      </label>
      {enhanced}
      {(hint || error) && (
        <p className={cx("field-message", error && "is-error")} id={messageId} role={error ? "alert" : undefined}>
          {error ? <Icon name="circle-alert" size={12} /> : null}
          <span>{error || hint}</span>
        </p>
      )}
    </div>
  )
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> & { prefix?: ReactNode; suffix?: ReactNode }

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, prefix, suffix, ...rest }, ref) {
  if (!prefix && !suffix) return <input ref={ref} className={cx("input", className)} {...rest} />
  return (
    <span className={cx("input-group", className)}>
      {prefix && <span className="input-affix">{prefix}</span>}
      <input ref={ref} className="input" {...rest} />
      {suffix && <span className="input-affix">{suffix}</span>}
    </span>
  )
})

export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false)
  return (
    <span className="input-group input-password">
      <input {...props} className="input" type={shown ? "text" : "password"} />
      <button type="button" className="input-reveal" aria-label={shown ? T("隐藏密码") : T("显示密码")} aria-pressed={shown} onClick={() => setShown(!shown)}>
        <Icon name={shown ? "eye-off" : "eye"} />
      </button>
    </span>
  )
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("input", "textarea", className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx("select", className)}>
      <select {...rest}>{children}</select>
      <Icon name="chevron-down" />
    </span>
  )
}

export function Switch({ checked, onChange, label, detail, disabled, id }: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  detail?: ReactNode
  disabled?: boolean
  id?: string
}) {
  const own = useId()
  return (
    <label className={cx("switch-row", disabled && "is-disabled")} htmlFor={id || own}>
      <button id={id || own} type="button" role="switch" aria-checked={!!checked} disabled={disabled} className="switch" onClick={() => onChange(!checked)}>
        <span className="switch-thumb"></span>
      </button>
      {(label || detail) && (
        <span className="switch-text">
          {label && <span className="switch-label">{label}</span>}
          {detail && <span className="switch-detail">{detail}</span>}
        </span>
      )}
    </label>
  )
}

export function Check({ checked, onChange, children, detail, disabled, name, value, required }: {
  checked: boolean
  onChange?: (next: boolean) => void
  children: ReactNode
  detail?: ReactNode
  disabled?: boolean
  name?: string
  value?: string
  required?: boolean
}) {
  return (
    <label className={cx("check-row", disabled && "is-disabled")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e.target.checked)} disabled={disabled} name={name} value={value} required={required} />
      <span className="check-box" aria-hidden="true"><Icon name="check" size={12} /></span>
      <span className="check-text">
        <span>{children}</span>
        {detail && <span className="check-detail">{detail}</span>}
      </span>
    </label>
  )
}

export type Option<V extends string> = { value: V; label?: ReactNode; icon?: IconName; count?: number }

/** A single choice among a few, drawn as a joined row. */
export function Segmented<V extends string>({ options, value, onChange, label, size, className }: {
  options: Option<V>[]
  value: V
  onChange: (next: V) => void
  label: string
  size?: "sm"
  className?: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const move = (to: number) => {
    const next = (to + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div
      className={cx("segmented", size && `segmented-${size}`, className)}
      role="radiogroup"
      aria-label={label}
      style={{ "--count": options.length, "--index": index } as CSSProperties}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(index + 1) }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(index - 1) }
      }}
    >
      <span className="segmented-thumb" aria-hidden="true"></span>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {o.label && <span>{o.label}</span>}
          {o.count !== undefined && <span className="segmented-count">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export type Tab<V extends string> = { value: V; label: ReactNode; icon?: IconName; count?: number }

/** ARIA tabs: one stop in the tab order; arrows and Home/End move and wrap. */
export function Tabs<V extends string>({ tabs, value, onChange, label, idPrefix = "tab" }: {
  tabs: Tab<V>[]
  value: V
  onChange: (next: V) => void
  label: string
  idPrefix?: string
}) {
  const refs = useRef<Partial<Record<V, HTMLButtonElement | null>>>({})
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        const at = tabs.findIndex((t) => t.value === value)
        const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null
        if (to === null) return
        e.preventDefault()
        const next = tabs[(to + tabs.length) % tabs.length].value
        onChange(next)
        refs.current[next]?.focus()
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.value}
          ref={(el) => { refs.current[t.value] = el }}
          id={`${idPrefix}-${t.value}`}
          role="tab"
          type="button"
          aria-selected={t.value === value}
          aria-controls={`${idPrefix}-panel-${t.value}`}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
        >
          {t.icon && <Icon name={t.icon} />}
          <span>{t.label}</span>
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
