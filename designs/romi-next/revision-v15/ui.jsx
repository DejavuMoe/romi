// Primitives shared by the status page and the panel.
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, Fragment } = React
const fmt = window.romiFormat

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const cx = (...parts) => parts.filter(Boolean).join(" ")

function Icon({ name, size = 16, className, style }) {
  return (
    <svg
      className={cx("icon", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
      dangerouslySetInnerHTML={{ __html: window.romiIcons[name] || "" }}
    ></svg>
  )
}

// The brand mark: a lowercase r whose shoulder is an orbit, with the probe
// riding ahead of it. The probe takes the fleet's health and pulses on each push.
function Mark({ size = 22, tone = "ok", beat }) {
  return (
    <svg className="mark" data-tone={tone} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="mark-r" d="M5.5 20V12A7 7 0 0 1 12.5 5" />
      <circle className="mark-probe" cx="18.3" cy="5" r="2.5" />
      {beat !== undefined && <circle className="mark-beat" key={beat} cx="18.3" cy="5" r="2.5" />}
    </svg>
  )
}

// Mark and name together; the name is the site's own.
function Brand({ name = "romi", tone, beat, size, version }) {
  return (
    <>
      <Mark tone={tone} beat={beat} size={size} />
      <span className="brand-name">{name}</span>
      {version && <span className="brand-version num">{version}</span>}
    </>
  )
}

const Button = React.forwardRef(function Button(
  { kind = "secondary", size, icon, iconAfter, busy, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", `btn-${kind}`, size && `btn-${size}`, busy && "is-busy", className)}
      aria-busy={busy || undefined}
      {...rest}
      disabled={rest.disabled || busy}
    >
      {busy ? <Icon name="loader-circle" className="spin" /> : icon && <Icon name={icon} />}
      {children && <span className="btn-label">{children}</span>}
      {iconAfter && <Icon name={iconAfter} />}
    </button>
  )
})

// An icon-only control. Its accessible name is also the tooltip it shows.
const IconButton = React.forwardRef(function IconButton({ label, icon, kind = "ghost", className, tip = "bottom", ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={cx("btn", `btn-${kind}`, "btn-icon", className)} aria-label={label} data-tip={tip} {...rest}>
      <Icon name={icon} />
      <span className="tip" aria-hidden="true">{label}</span>
    </button>
  )
})

function Kbd({ children }) {
  return <kbd className="kbd">{children}</kbd>
}

let fieldSeq = 0
const useId = (prefix = "f") => {
  const ref = useRef(null)
  if (ref.current === null) ref.current = `${prefix}-${++fieldSeq}`
  return ref.current
}

// Label above, one message line below that holds the hint or, in its place, the
// error, so a refusal never moves the controls around it.
function Field({ label, hint, error, children, className, htmlFor, optional, inline }) {
  const id = useId("field")
  const control = htmlFor || `${id}-control`
  const messageId = `${id}-message`
  const child = React.Children.only(children)
  const described = hint || error ? messageId : undefined
  const enhanced = React.cloneElement(child, {
    id: child.props.id || control,
    "aria-describedby": described,
    "aria-invalid": error ? true : undefined,
  })
  return (
    <div className={cx("field", error && "has-error", inline && "field-inline", className)}>
      <label className="field-label" htmlFor={child.props.id || control}>
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

const Input = React.forwardRef(function Input({ className, prefix, suffix, ...rest }, ref) {
  if (!prefix && !suffix) return <input ref={ref} className={cx("input", className)} {...rest} />
  return (
    <span className={cx("input-group", className)}>
      {prefix && <span className="input-affix">{prefix}</span>}
      <input ref={ref} className="input" {...rest} />
      {suffix && <span className="input-affix">{suffix}</span>}
    </span>
  )
})

function PasswordInput(props) {
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

function Textarea({ className, ...rest }) {
  return <textarea className={cx("input", "textarea", className)} {...rest} />
}

function Select({ className, children, ...rest }) {
  return (
    <span className={cx("select", className)}>
      <select {...rest}>{children}</select>
      <Icon name="chevron-down" />
    </span>
  )
}

function Switch({ checked, onChange, label, detail, disabled, id }) {
  const own = useId("switch")
  return (
    <label className={cx("switch-row", disabled && "is-disabled")} htmlFor={id || own}>
      <button
        id={id || own}
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
      >
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

function Check({ checked, onChange, children, detail, disabled, name, value, required }) {
  return (
    <label className={cx("check-row", disabled && "is-disabled")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange && onChange(e.target.checked)} disabled={disabled} name={name} value={value} required={required} />
      <span className="check-box" aria-hidden="true"><Icon name="check" size={12} /></span>
      <span className="check-text">
        <span>{children}</span>
        {detail && <span className="check-detail">{detail}</span>}
      </span>
    </label>
  )
}

// A single choice among a few, drawn as a joined row.
function Segmented({ options, value, onChange, label, size, className }) {
  const refs = useRef([])
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const move = (to) => {
    const next = (to + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }
  return (
    <div
      className={cx("segmented", size && `segmented-${size}`, className)}
      role="radiogroup"
      aria-label={label}
      style={{ "--count": options.length, "--index": index }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(index + 1) }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(index - 1) }
      }}
    >
      <span className="segmented-thumb" aria-hidden="true"></span>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => (refs.current[i] = el)}
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

// ARIA tabs: one stop in the tab order, arrows and Home/End move and wrap.
function Tabs({ tabs, value, onChange, label, idPrefix = "tab" }) {
  const refs = useRef({})
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        const at = tabs.findIndex((t) => t.value === value)
        const to =
          e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null
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
          ref={(el) => (refs.current[t.value] = el)}
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

// ---- overlays --------------------------------------------------------------

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Keeps focus inside, closes on Escape, hands focus back to what opened it, and
// locks page scroll without the scrollbar's width shifting the layout.
function useOverlay(open, onClose, panelRef, focusPanel) {
  useLayoutEffect(() => {
    if (!open) return
    const opener = document.activeElement
    const root = document.documentElement
    // The page's scrollbar gutter becomes padding of the same width, so the scrim
    // covers the whole window and nothing behind it moves.
    if (!root.classList.contains("is-locked")) root.style.setProperty("--gutter-w", `${innerWidth - root.clientWidth}px`)
    root.classList.add("is-locked")
    const panel = panelRef.current
    const first = focusPanel ? panel : panel && (panel.querySelector("[data-autofocus]") || panel.querySelector(FOCUSABLE))
    requestAnimationFrame(() => (first || panel)?.focus())
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
      if (e.key !== "Tab" || !panel) return
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null)
      if (!items.length) return
      const [a, b] = [items[0], items[items.length - 1]]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus() }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus() }
    }
    panel?.addEventListener("keydown", key)
    return () => {
      panel?.removeEventListener("keydown", key)
      if (!document.querySelector(".overlay")) document.documentElement.classList.remove("is-locked")
      requestAnimationFrame(() => {
        if (!document.querySelector(".overlay")) document.documentElement.classList.remove("is-locked")
        if (opener && document.contains(opener)) opener.focus()
      })
    }
  }, [open])
}

// Head, an optional bar such as tabs, and the foot stay put; only the body
// scrolls, and every row keeps the same scrollbar gutter, so the surface never
// changes size or shifts when its content grows or shrinks.
function Dialog({ title, subtitle, onClose, children, footer, size = "md", kind = "center", className, labelledBy, head, bar, focusPanel }) {
  const panel = useRef(null)
  const titleId = useId("dialog")
  useOverlay(true, onClose, panel, focusPanel)
  return ReactDOM.createPortal(
    <div className={cx("overlay", `overlay-${kind}`)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={cx("dialog", `dialog-${kind}`, `dialog-${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || titleId}
        tabIndex={-1}
      >
        <div className="dialog-head">
          {head || (
            <div className="dialog-titles">
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p className="dialog-subtitle">{subtitle}</p>}
            </div>
          )}
          <IconButton label={T("关闭")} icon="x" onClick={onClose} className="dialog-close" tip="left" />
        </div>
        {bar && <div className="dialog-bar">{bar}</div>}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

function Confirm({ title, detail, confirmLabel = T("确认"), danger = true, onConfirm, onClose, busy, children }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} data-autofocus>{T("取消")}</Button>
          <Button kind={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {detail && <p className="confirm-detail">{detail}</p>}
      {children}
    </Dialog>
  )
}

// Toasts: one live region, newest last, each dismissing itself.
const toastStore = { items: [], listeners: new Set(), seq: 0 }
function toast(text, tone = "ok") {
  const id = ++toastStore.seq
  toastStore.items = [...toastStore.items, { id, text, tone }].slice(-3)
  toastStore.listeners.forEach((fn) => fn(toastStore.items))
  setTimeout(() => {
    toastStore.items = toastStore.items.filter((t) => t.id !== id)
    toastStore.listeners.forEach((fn) => fn(toastStore.items))
  }, 3200)
}
function Toasts() {
  const [items, setItems] = useState(toastStore.items)
  useEffect(() => {
    toastStore.listeners.add(setItems)
    return () => toastStore.listeners.delete(setItems)
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

async function copyText(text, what = T("已复制")) {
  try {
    await navigator.clipboard.writeText(text)
    toast(what)
    return true
  } catch (_) {
    toast(T("无法访问剪贴板，请手动选择并复制"), "bad")
    return false
  }
}

// A value with its copy control beside it; the control shows on hover and focus,
// and stays faintly visible on touch screens.
function CopyValue({ value, label, empty = T("未上报"), mono = true, className }) {
  const [done, setDone] = useState(false)
  if (!value) return <span className={cx("copy-value is-empty", className)}>{empty}</span>
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

// A block of command text with its own copy action.
function CodeBlock({ code, label, disabled, empty }) {
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

// ---- status ----------------------------------------------------------------

function StatusDot({ status, beat, size }) {
  return (
    <span className="status-dot" data-status={status} style={size ? { "--dot": `${size}px` } : null} aria-hidden="true">
      {status === "online" && beat !== undefined && <i className="status-ripple" key={beat}></i>}
    </span>
  )
}
function StatusBadge({ node, beat, compact }) {
  const status = fmt.connection(node)
  return (
    <span className={cx("status", compact && "status-compact")} data-status={status}>
      <StatusDot status={status} beat={beat} />
      <span>{fmt.CONNECTION[status]}</span>
    </span>
  )
}

// Download or upload: a coloured arrow, and the word for screen readers.
function DirMark({ dir }) {
  return (
    <span className="dir" data-dir={dir}>
      <Icon name={dir === "down" ? "arrow-down" : "arrow-up"} size={12} />
      <span className="sr-only">{dir === "down" ? T("下载") : T("上传")}</span>
    </span>
  )
}

// A figure with its direction; animated when it is a number.
function DirValue({ dir, value, unit, digits = 1 }) {
  return (
    <span className="dir-value" data-dir={dir}>
      <DirMark dir={dir} />
      <span className="num">
        {value == null ? "—" : typeof value === "number" ? <AnimatedNumber value={value} format={(v) => v.toFixed(digits)} /> : value}
        {value != null && unit && <span className="unit">{unit}</span>}
      </span>
    </span>
  )
}

function Region({ code, full }) {
  if (!code) return null
  const name = window.romiGeo.countryName(code)
  return (
    <span className="region" data-tip-text={name}>
      <span className="region-code">{code}</span>
      {full && <span className="region-name">{name}</span>}
    </span>
  )
}

// Whether it is day or night where the node is, from the sun's position now.
const SKY = {
  day: { icon: "sun", label: "当地白天" },
  night: { icon: "moon", label: "当地夜间" },
  dawn: { icon: "sunrise", label: "当地黎明" },
  dusk: { icon: "sunset", label: "当地黄昏" },
}
function LocalSky({ code, text }) {
  useNow(60000)
  const sky = window.romiGeo.sky(code)
  if (!sky) return null
  const s = { ...SKY[sky], label: T(SKY[sky].label) }
  return (
    <span className="sky" data-sky={sky} role={text ? undefined : "img"} aria-label={text ? undefined : s.label} data-tip-text={s.label}>
      <Icon name={s.icon} size={14} />
      {text && <span>{s.label}</span>}
    </span>
  )
}

// A bar whose fill carries the level; the number beside it says it in words.
function Meter({ value, tone, thin, marker, label }) {
  const t = tone || fmt.tone(value)
  const width = value == null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <span className={cx("meter", thin && "meter-thin")} data-tone={t} aria-hidden={label ? undefined : "true"} role={label ? "meter" : undefined} aria-label={label} aria-valuenow={label && value != null ? Math.round(value) : undefined} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined}>
      <span className="meter-fill" style={{ width: `${width}%` }}></span>
      {marker != null && <span className="meter-marker" style={{ left: `${Math.max(0, Math.min(100, marker))}%` }}></span>}
    </span>
  )
}

function Empty({ icon = "server", title, detail, action, onAction, error, secondary, onSecondary, compact }) {
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

function Notice({ tone = "info", icon, children, action }) {
  return (
    <div className="notice" data-tone={tone} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon || (tone === "bad" ? "triangle-alert" : tone === "warn" ? "circle-alert" : "info")} />
      <div className="notice-text">{children}</div>
      {action}
    </div>
  )
}

// ---- live data -------------------------------------------------------------

// The node list as the hub last pushed it, re-rendered on every push.
function useFleet() {
  const [, setVersion] = useState(0)
  useEffect(() => window.romiSim.subscribe(() => setVersion((v) => v + 1)), [])
  const nodes = window.romiSim.nodes().map((n) => ({ ...n }))
  return { nodes, tick: window.romiSim.tick(), connected: window.romiSim.connected() }
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// Moves from the previous value to the new one; the digits are tabular so the
// width holds still while they change.
function AnimatedNumber({ value, format = (v) => String(Math.round(v)), duration = 700, className }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const frame = useRef(0)
  useEffect(() => {
    if (value == null || !Number.isFinite(value) || reduceMotion()) {
      setShown(value)
      from.current = value
      return
    }
    const start = performance.now()
    const a = Number.isFinite(from.current) ? from.current : value
    cancelAnimationFrame(frame.current)
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration)
      const e = 1 - Math.pow(1 - p, 3)
      const v = a + (value - a) * e
      setShown(v)
      from.current = v
      if (p < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [value])
  return <span className={cx("num", className)}>{shown == null || !Number.isFinite(shown) ? "—" : format(shown)}</span>
}

// A value and its unit set as one: the unit smaller and quieter, same line.
function Quantity({ value, unit, className, animate = true, parts }) {
  return (
    <span className={cx("qty", className)}>
      {animate && typeof value === "number" ? <AnimatedNumber value={value} format={parts} /> : <span className="num">{value}</span>}
      {unit && <span className="unit">{unit}</span>}
    </span>
  )
}

// Theme: stored per browser; a toggle draws the new theme outward from the
// button that asked for it where the browser can.
function useTheme() {
  const params = new URLSearchParams(location.search)
  const [theme, setTheme] = useState(
    () => params.get("theme") || localStorage.getItem("romi-v15-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  )
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem("romi-v15-theme", theme)
  }, [theme])
  const toggle = (event) => {
    const next = theme === "dark" ? "light" : "dark"
    if (!document.startViewTransition || reduceMotion()) return setTheme(next)
    const r = event?.currentTarget?.getBoundingClientRect()
    const x = r ? r.left + r.width / 2 : innerWidth - 40
    const y = r ? r.top + r.height / 2 : 28
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    document.documentElement.classList.add("theme-transition")
    const vt = document.startViewTransition(() => ReactDOM.flushSync(() => setTheme(next)))
    vt.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 620, easing: "cubic-bezier(.2,.7,.2,1)", pseudoElement: "::view-transition-new(root)" },
      )
    })
    vt.finished.finally(() => document.documentElement.classList.remove("theme-transition"))
  }
  return [theme, toggle]
}
// The page language, re-rendering its caller when it changes.
function useLocale() {
  const [locale, setLocale] = useState(window.romiI18n.locale)
  useEffect(() => window.romiI18n.subscribe(setLocale), [])
  return locale
}
// Names the other language in that language, the way language menus do.
function LangButton() {
  const locale = useLocale()
  const next = locale === "en" ? { code: "zh-CN", name: "中文", mark: "中" } : { code: "en", name: "English", mark: "EN" }
  return (
    <button type="button" className="btn btn-ghost btn-icon lang-button" lang={next.code} aria-label={next.name} data-tip="bottom" onClick={() => window.romiI18n.setLocale(next.code)}>
      <span className="lang-mark" aria-hidden="true">{next.mark}</span>
      <span className="tip" aria-hidden="true">{next.name}</span>
    </button>
  )
}
function ThemeButton({ theme, onToggle }) {
  return <IconButton label={theme === "dark" ? T("切换浅色主题") : T("切换深色主题")} icon={theme === "dark" ? "sun" : "moon"} onClick={onToggle} />
}

// Page transitions share elements by name where the browser can.
function transition(update) {
  if (!document.startViewTransition || reduceMotion()) return update()
  document.startViewTransition(() => ReactDOM.flushSync(update))
}

// Hash routes: "#/node/3" → ["node", "3"].
function useRoute(fallback) {
  const read = () => (location.hash.replace(/^#\/?/, "") || fallback).split("/")
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const sync = () => setRoute(read())
    addEventListener("hashchange", sync)
    return () => removeEventListener("hashchange", sync)
  }, [])
  const go = (path, { animate = true } = {}) => {
    const apply = () => {
      if (location.hash !== `#/${path}`) history.pushState(null, "", `#/${path}`)
      setRoute(path.split("/"))
      scrollTo({ top: 0 })
    }
    animate ? transition(apply) : apply()
  }
  return [route, go]
}

// The fleet's overall tone, for the brand mark and the tab icon.
function fleetTone(nodes) {
  const statuses = nodes.map((n) => fmt.connection(n))
  if (statuses.includes("offline")) return "bad"
  const hot = nodes.some((n) => n.online && n.metrics && (n.metrics.cpu >= 85 || fmt.percent(n.metrics.mem_used, n.metrics.mem_total) >= 85 || fmt.percent(n.metrics.disk_used, n.metrics.disk_total) >= 85))
  if (statuses.includes("reconnecting") || hot) return "warn"
  return "ok"
}
// Draws the favicon: the mark in white on a violet tile, the probe in the
// fleet's tone once something needs attention.
function useFavicon(tone) {
  useEffect(() => {
    const probe = { ok: "#ffffff", warn: "#f5b83d", bad: "#ff5a60" }
    const c = document.createElement("canvas")
    c.width = c.height = 64
    const g = c.getContext("2d")
    g.fillStyle = "#5a44ee"
    g.beginPath(); g.roundRect(0, 0, 64, 64, 16); g.fill()
    // The 24-unit mark, drawn at 2.1× about the tile's centre.
    g.setTransform(2.1, 0, 0, 2.1, 32 - 12 * 2.1, 32 - 12 * 2.1)
    g.strokeStyle = "#ffffff"
    g.lineWidth = 3.4
    g.lineCap = "round"
    g.beginPath(); g.moveTo(5.5, 20); g.lineTo(5.5, 12); g.arc(12.5, 12, 7, Math.PI, Math.PI * 1.5); g.stroke()
    g.fillStyle = probe[tone] || probe.ok
    g.beginPath(); g.arc(18.3, 5, 2.8, 0, Math.PI * 2); g.fill()
    let link = document.querySelector("link[rel=icon]")
    if (!link) {
      link = document.createElement("link")
      link.rel = "icon"
      document.head.appendChild(link)
    }
    link.href = c.toDataURL()
  }, [tone])
}

function useHotkey(match, handler, deps = []) {
  useEffect(() => {
    const on = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
      if (match(e, typing)) {
        e.preventDefault()
        handler(e)
      }
    }
    addEventListener("keydown", on)
    return () => removeEventListener("keydown", on)
  }, deps)
}

// Review scenarios selected with ?state=…; not a product setting.
const scenario = new URLSearchParams(location.search).get("state") || "ready"

Object.assign(window, {
  cx, reduceMotion, Icon, Mark, Brand, Button, IconButton, Kbd, Field, Input, PasswordInput, Textarea, Select, Switch, Check,
  Segmented, Tabs, Dialog, Confirm, toast, Toasts, copyText, CopyValue, CodeBlock, StatusDot, StatusBadge, DirMark, DirValue, Region, LocalSky,
  Meter, Empty, Notice, useFleet, useNow, AnimatedNumber, Quantity, useTheme, ThemeButton, useLocale, LangButton, transition, useRoute,
  fleetTone, useFavicon, useHotkey, useId, scenario, useOverlay,
})
