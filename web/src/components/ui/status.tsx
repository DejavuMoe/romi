import { useEffect, useRef, useState, type CSSProperties } from "react"

import { countryName, sky as skyAt, type Sky } from "../../../../shared/geo.ts"
import { T } from "../../../../shared/i18n.ts"
import { CONNECTION, connection, type Connection } from "../../../../shared/nodes.ts"
import type { Node } from "../../lib/api"
import { rateParts, tone as toneOf } from "../../lib/format"
import { cx, reduceMotion, useNow } from "../../lib/hooks"
import { Icon } from "./icon"

export function StatusDot({ status, beat, size }: { status: Connection; beat?: number; size?: number }) {
  return (
    <span className="status-dot" data-status={status} style={size ? ({ "--dot": `${size}px` } as CSSProperties) : undefined} aria-hidden="true">
      {status === "online" && beat !== undefined && <i className="status-ripple" key={beat}></i>}
    </span>
  )
}

export function StatusBadge({ node, beat, compact }: { node: Node; beat?: number; compact?: boolean }) {
  const status = connection(node)
  return (
    <span className={cx("status", compact && "status-compact")} data-status={status}>
      <StatusDot status={status} beat={beat} />
      <span>{T(CONNECTION[status])}</span>
    </span>
  )
}

/** Download or upload: a coloured arrow, and the word for screen readers. */
export function DirMark({ dir }: { dir: "down" | "up" }) {
  return (
    <span className="dir" data-dir={dir}>
      <Icon name={dir === "down" ? "arrow-down" : "arrow-up"} size={12} />
      <span className="sr-only">{dir === "down" ? T("下载") : T("上传")}</span>
    </span>
  )
}

/** A figure with its direction; animated when it is a number. */
export function DirValue({ dir, value, unit, digits = 1 }: { dir: "down" | "up"; value: number | string | null | undefined; unit?: string; digits?: number }) {
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

/** A rate with its direction mark. */
export function FlowValue({ dir, value }: { dir: "down" | "up"; value: number | null | undefined }) {
  const parts = value != null ? rateParts(value) : null
  return <DirValue dir={dir} value={parts ? parts.value : null} unit={parts?.unit} />
}

export function Region({ code, full }: { code?: string | null; full?: boolean }) {
  if (!code) return null
  const name = countryName(code)
  return (
    <span className="region" data-tip-text={name}>
      <span className="region-code">{code}</span>
      {full && <span className="region-name">{name}</span>}
    </span>
  )
}

// Whether it is day or night where the node is, from the sun's position now.
const SKY: Record<Sky, { icon: "sun" | "moon" | "sunrise" | "sunset"; label: string }> = {
  day: { icon: "sun", label: "当地白天" },
  night: { icon: "moon", label: "当地夜间" },
  dawn: { icon: "sunrise", label: "当地黎明" },
  dusk: { icon: "sunset", label: "当地黄昏" },
}

export function LocalSky({ code, text }: { code?: string | null; text?: boolean }) {
  useNow(60000)
  const sky = skyAt(code)
  if (!sky) return null
  const label = T(SKY[sky].label)
  return (
    <span className="sky" data-sky={sky} role={text ? undefined : "img"} aria-label={text ? undefined : label} data-tip-text={label}>
      <Icon name={SKY[sky].icon} size={14} />
      {text && <span>{label}</span>}
    </span>
  )
}

/** A bar whose fill carries the level; the number beside it says it in words. */
export function Meter({ value, tone, thin, marker, label }: { value: number | null | undefined; tone?: string; thin?: boolean; marker?: number | null; label?: string }) {
  const t = tone || toneOf(value)
  const width = value == null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <span
      className={cx("meter", thin && "meter-thin")}
      data-tone={t}
      aria-hidden={label ? undefined : "true"}
      role={label ? "meter" : undefined}
      aria-label={label}
      aria-valuenow={label && value != null ? Math.round(value) : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
    >
      <span className="meter-fill" style={{ width: `${width}%` }}></span>
      {marker != null && <span className="meter-marker" style={{ left: `${Math.max(0, Math.min(100, marker))}%` }}></span>}
    </span>
  )
}

/**
 * Moves from the previous value to the new one; the digits are tabular so the
 * width holds still while they change.
 */
export function AnimatedNumber({ value, format = (v) => String(Math.round(v)), duration = 700, className }: {
  value: number | null | undefined
  format?: (v: number) => string
  duration?: number
  className?: string
}) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const frame = useRef(0)
  const still = value == null || !Number.isFinite(value) || reduceMotion()
  useEffect(() => {
    if (value == null || !Number.isFinite(value) || reduceMotion()) {
      from.current = value
      return
    }
    const start = performance.now()
    const a = from.current != null && Number.isFinite(from.current) ? from.current : value
    cancelAnimationFrame(frame.current)
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const e = 1 - Math.pow(1 - p, 3)
      const v = a + (value - a) * e
      setShown(v)
      from.current = v
      if (p < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [value, duration])
  const figure = still ? value : shown
  return <span className={cx("num", className)}>{figure == null || !Number.isFinite(figure) ? "—" : format(figure)}</span>
}

/** A value and its unit set as one: the unit smaller and quieter, same line. */
export function Quantity({ value, unit, className, animate = true, parts }: { value: number | string; unit?: string; className?: string; animate?: boolean; parts?: (v: number) => string }) {
  return (
    <span className={cx("qty", className)}>
      {animate && typeof value === "number" ? <AnimatedNumber value={value} format={parts} /> : <span className="num">{value}</span>}
      {unit && <span className="unit">{unit}</span>}
    </span>
  )
}
