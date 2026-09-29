import { useId, type CSSProperties, type ReactNode } from "react"

import { T } from "../../../shared/i18n.ts"
import type { Node } from "../lib/api"
import { bytes, MODES, monthUsage, nextReset, pair, projection, shortDate } from "../lib/format"
import { cx } from "../lib/hooks"

/** Monotone cubic through the points, so a curve never overshoots a sample. */
export function monotonePath(pts: [number, number][]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : ""
  const n = pts.length
  const dx: number[] = [], dy: number[] = [], m: number[] = [], t: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0]
    dy[i] = pts[i + 1][1] - pts[i][1]
    m[i] = dx[i] ? dy[i] / dx[i] : 0
  }
  t[0] = m[0]
  t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i])
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += `C${(pts[i][0] + h).toFixed(2)},${(pts[i][1] + h * t[i]).toFixed(2)} ${(pts[i + 1][0] - h).toFixed(2)},${(pts[i + 1][1] - h * t[i + 1]).toFixed(2)} ${pts[i + 1][0].toFixed(2)},${pts[i + 1][1].toFixed(2)}`
  }
  return d
}

/** Runs of consecutive present values; a null or a long pause ends a run. */
export function runs(values: (number | null | undefined)[], xs?: number[], maxGap?: number): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  values.forEach((v, i) => {
    const broken = v == null || !Number.isFinite(v) || (maxGap && xs && cur.length && xs[i] - xs[i - 1] > maxGap)
    if (broken && cur.length) {
      out.push(cur)
      cur = []
    }
    if (v != null && Number.isFinite(v)) cur.push(i)
  })
  if (cur.length) out.push(cur)
  return out
}

/**
 * The trace on a card: the last three minutes, the newest sample at the right
 * edge, sliding in on each push.
 */
export function Sparkline<P>({ points, get, max, height = 44, color = "var(--trend)", beat, label, className, fixed }: {
  points: P[]
  get: (p: P) => number | null | undefined
  max?: number
  height?: number
  color?: string
  beat?: number
  label?: string
  className?: string
  fixed?: boolean
}) {
  const gid = useId()
  const n = points.length
  const values = points.map(get)
  // Scaled to its own recent peak with a floor, so a quiet trace still has shape.
  const top = fixed && max ? max : Math.min(max || Infinity, Math.max(10, ...values.filter((v): v is number => v != null).map((v) => v * 1.35)))
  const H = height
  const X = (i: number) => (i / Math.max(1, n - 1)) * 100
  const Y = (v: number) => H - 2 - (Math.max(0, Math.min(v, top)) / top) * (H - 6)
  const segs = runs(values)
  const last = values[n - 1]
  const step = 100 / Math.max(1, n - 1)
  const lines = segs.map((idx) => monotonePath(idx.map((i) => [X(i), Y(values[i] as number)])))
  const areas = segs.map((idx, k) => `${lines[k]}L${X(idx[idx.length - 1]).toFixed(2)},${H}L${X(idx[0]).toFixed(2)},${H}Z`)
  return (
    <div
      className={cx("spark", last == null && "is-idle", className)}
      style={{ height: H, "--spark": color } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" width="100%" height={H}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28"></stop>
            <stop offset="1" stopColor={color} stopOpacity="0"></stop>
          </linearGradient>
        </defs>
        {(last == null || !segs.some((s) => s.length > 1)) && <line x1="0" x2="100" y1={H - 2} y2={H - 2} className="spark-flat" vectorEffect="non-scaling-stroke"></line>}
        <g className="spark-shift" key={beat} style={{ "--shift": `${step}px` } as CSSProperties}>
          {areas.map((d, i) => <path key={`a${i}`} d={d} fill={`url(#${gid})`}></path>)}
          {lines.map((d, i) => <path key={`l${i}`} d={d} className="spark-line" vectorEffect="non-scaling-stroke"></path>)}
        </g>
      </svg>
      {last != null && <span className="spark-head" key={`h${beat}`} style={{ top: `${(Y(last) / H) * 100}%` }}></span>}
    </div>
  )
}

/**
 * The billing period's usage against its quota, with where the current pace
 * would end the period.
 */
export function QuotaBar({ node, threshold = 80, compact }: { node: Node; threshold?: number; compact?: boolean }) {
  const used = monthUsage(node)
  const limit = node.traffic_limit
  const pct = limit > 0 ? (used / limit) * 100 : null
  const proj = limit > 0 ? projection(node) : null
  const projPct = proj ? (proj.value / limit) * 100 : null
  const tone = pct == null ? "normal" : pct >= 100 ? "critical" : pct >= threshold ? "warning" : "normal"
  const projTone = projPct != null && projPct >= 100 ? "critical" : projPct != null && projPct >= threshold ? "warning" : "normal"
  return (
    <div className={cx("quota", compact && "quota-compact")} data-tone={tone}>
      <div className="quota-row">
        <span className="quota-label">{T("本期流量")}</span>
        <span className="quota-value num">
          {limit > 0 ? pair(used, limit) : bytes(used)}
          {limit > 0 ? null : <span className="muted"> {T("· 不限")}</span>}
        </span>
      </div>
      <span className="quota-track" aria-hidden="true">
        {projPct != null && <span className="quota-proj" data-tone={projTone} style={{ width: `${Math.min(100, projPct)}%` }}></span>}
        <span className="quota-fill" style={{ width: `${Math.min(100, pct || 0)}%` }}></span>
        {limit > 0 && <span className="quota-threshold" style={{ left: `${threshold}%` }}></span>}
      </span>
      {!compact && (
        <div className="quota-foot">
          <span>
            {proj ? <>{T("预计")} <b className={projTone !== "normal" ? `ink-${projTone}` : ""}>{bytes(proj.value)}</b></> : pct != null ? `${pct.toFixed(0)}%` : T(MODES[node.traffic_mode] ?? MODES.sum)}
          </span>
          <span>{T("{date}重置", { date: shortDate(nextReset(node.traffic_reset_day || 1)) })}</span>
        </div>
      )}
    </div>
  )
}

export function Ring({ value, max = 1, size = 44, stroke = 4, tone = "accent", children, label }: {
  value: number
  max?: number
  size?: number
  stroke?: number
  tone?: string
  children?: ReactNode
  label?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, value / max))
  return (
    <span className="ring" data-tone={tone} style={{ width: size, height: size }} role={label ? "img" : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="ring-track"></circle>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform={`rotate(-90 ${size / 2} ${size / 2})`}></circle>
      </svg>
      {children && <span className="ring-inner">{children}</span>}
    </span>
  )
}
