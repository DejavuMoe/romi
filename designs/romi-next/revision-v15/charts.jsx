// Charts: the live trace on cards, the history panels on the detail page, and
// the quota and countdown gauges.

function useWidth(ref) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    ro.observe(ref.current)
    setWidth(Math.round(ref.current.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  return width
}

// Monotone cubic through the points, so a curve never overshoots a sample.
function monotonePath(pts) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : ""
  const n = pts.length
  const dx = [], dy = [], m = [], t = []
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
// Runs of consecutive present values; a null or a long pause ends a run.
function runs(values, xs, maxGap) {
  const out = []
  let cur = []
  values.forEach((v, i) => {
    const broken = v == null || !Number.isFinite(v) || (maxGap && cur.length && xs[i] - xs[i - 1] > maxGap)
    if (broken && cur.length) {
      out.push(cur)
      cur = []
    }
    if (v != null && Number.isFinite(v)) cur.push(i)
  })
  if (cur.length) out.push(cur)
  return out
}

// The trace on a card: the last three minutes, the newest sample at the right
// edge, sliding in on each push.
function Sparkline({ points, get, max, height = 44, color = "var(--trend)", beat, label, className, fixed }) {
  const n = points.length
  const values = points.map(get)
  // Scaled to its own recent peak with a floor, so a quiet trace still has shape.
  const top = fixed ? max : Math.min(max || Infinity, Math.max(10, ...values.filter((v) => v != null).map((v) => v * 1.35)))
  const H = height
  const X = (i) => (i / Math.max(1, n - 1)) * 100
  const Y = (v) => H - 2 - (Math.max(0, Math.min(v, top)) / top) * (H - 6)
  const segs = runs(values)
  const last = values[n - 1]
  const step = 100 / Math.max(1, n - 1)
  const lines = segs.map((idx) => monotonePath(idx.map((i) => [X(i), Y(values[i])])))
  const areas = segs.map((idx, k) => `${lines[k]}L${X(idx[idx.length - 1]).toFixed(2)},${H}L${X(idx[0]).toFixed(2)},${H}Z`)
  const gid = useId("spark")
  return (
    <div className={cx("spark", last == null && "is-idle", className)} style={{ height: H, "--spark": color }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" width="100%" height={H}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28"></stop>
            <stop offset="1" stopColor={color} stopOpacity="0"></stop>
          </linearGradient>
        </defs>
        {last == null && <line x1="0" x2="100" y1={H - 2} y2={H - 2} className="spark-flat" vectorEffect="non-scaling-stroke"></line>}
        <g className="spark-shift" key={beat} style={{ "--shift": `${step}px` }}>
          {areas.map((d, i) => <path key={`a${i}`} d={d} fill={`url(#${gid})`}></path>)}
          {lines.map((d, i) => <path key={`l${i}`} d={d} className="spark-line" vectorEffect="non-scaling-stroke"></path>)}
        </g>
      </svg>
      {last != null && <span className="spark-head" key={`h${beat}`} style={{ top: `${(Y(last) / H) * 100}%` }}></span>}
    </div>
  )
}

const KIND = {
  percent: { tick: (v) => `${Math.round(v)}%`, value: (v) => `${v.toFixed(1)}%`, max: () => 100 },
  bytes: { tick: (v) => fmt.axisBytes(v), value: (v) => fmt.bytes(v), max: (m) => fmt.niceMax(m, "bytes") },
  rate: { tick: (v) => `${fmt.axisBytes(v)}/s`, value: (v) => fmt.rate(v), max: (m) => fmt.niceMax(m, "bytes") },
  count: { tick: (v) => String(Math.round(v)), value: (v) => String(Math.round(v)), max: (m) => fmt.niceMax(m) },
  ms: { tick: (v) => `${v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)} ms`, value: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`, max: (m) => fmt.niceMax(m) },
}
const AXIS_W = 56
const AXIS_H = 24

// One history panel. Every panel on the page shares one hover time and one zoom,
// so a spike reads across all of them at the same x.
function HistoryChart({ title, summary, ts, series, kind = "percent", lead, domain, hover, onHover, onZoom, height = 176, loss, step = 60, empty, onToggle, hidden = [], max }) {
  const wrap = useRef(null)
  const width = useWidth(wrap)
  const [drag, setDrag] = useState(null)
  const clipId = useId("clip")
  const K = KIND[kind]
  const [from, to] = domain
  const plotW = Math.max(10, width - AXIS_W - 8)
  const plotH = height - AXIS_H
  const inView = ts.map((t) => t >= from && t <= to)
  const shown = series.filter((s) => !hidden.includes(s.key))
  const peak = Math.max(0, ...shown.flatMap((s) => s.values.filter((v, i) => inView[i] && v != null).concat(s.band ? s.band.filter((b, i) => b && inView[i]).map((b) => b[1]) : [])))
  const top = kind === "percent" ? 100 : max || K.max(peak * 1.08 || 1)
  const X = (t) => AXIS_W + ((t - from) / (to - from || 1)) * plotW
  const Y = (v) => 6 + plotH - 6 - (Math.max(0, Math.min(v, top)) / top) * (plotH - 10)
  const yTicks = [0, top / 2, top]
  const xTicks = fmt.timeTicks(from * 1000, to * 1000, Math.max(2, Math.floor(plotW / 110)))
  const label = fmt.clockFor((to - from) / 3600)
  const nothing = !shown.some((s) => s.values.some((v, i) => v != null && inView[i]))

  const nearest = (clientX) => {
    const r = wrap.current.getBoundingClientRect()
    const t = from + ((clientX - r.left - AXIS_W) / plotW) * (to - from)
    let best = -1, dist = Infinity
    ts.forEach((x, i) => {
      if (!inView[i]) return
      const d = Math.abs(x - t)
      if (d < dist) { dist = d; best = i }
    })
    return { index: best, t }
  }
  const at = hover != null ? ts.findIndex((t) => t === hover) : -1
  const hoverX = at >= 0 ? X(ts[at]) : null

  const paths = shown.map((s) => {
    const segs = runs(s.values.map((v, i) => (inView[i] || (i > 0 && inView[i - 1]) || inView[i + 1] ? v : null)), ts, step * 1.6)
    const line = segs.map((idx) => monotonePath(idx.map((i) => [X(ts[i]), Y(s.values[i])])))
    const area = segs.map((idx, k) => `${line[k]}L${X(ts[idx[idx.length - 1]]).toFixed(1)},${Y(0)}L${X(ts[idx[0]]).toFixed(1)},${Y(0)}Z`)
    const band = s.band
      ? runs(s.band.map((b) => (b ? b[1] : null)), ts, step * 1.6).map((idx) => {
          const upper = idx.map((i) => `${X(ts[i]).toFixed(1)},${Y(s.band[i][1]).toFixed(1)}`)
          const lower = idx.slice().reverse().map((i) => `${X(ts[i]).toFixed(1)},${Y(s.band[i][0]).toFixed(1)}`)
          return `M${upper.join("L")}L${lower.join("L")}Z`
        })
      : []
    return { s, line, area, band }
  })
  // Missing stretches inside the window, drawn so a gap reads as "no report".
  const gapRects = []
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > step * 1.6 && ts[i] > from && ts[i - 1] < to) gapRects.push([Math.max(from, ts[i - 1]), Math.min(to, ts[i])])
  }
  if (ts.length && to - ts[ts.length - 1] > step * 2) gapRects.push([Math.max(from, ts[ts.length - 1]), to])

  const tipLeft = hoverX != null && hoverX > width - 200
  return (
    <figure className={cx("chart", lead && "is-lead", nothing && "is-empty")} aria-label={title}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {summary && <span className="chart-summary">{summary}</span>}
      </figcaption>
      <div
        ref={wrap}
        className="chart-plot"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={T("{title}，{from} 至 {to}", { title, from: label(from * 1000), to: label(to * 1000) })}
        onPointerMove={(e) => {
          if (!width) return
          const { index, t } = nearest(e.clientX)
          if (index >= 0) onHover(ts[index])
          if (drag) setDrag({ ...drag, b: Math.max(from, Math.min(to, t)) })
        }}
        onPointerLeave={() => { onHover(null); }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !onZoom) return
          e.currentTarget.setPointerCapture(e.pointerId)
          const { t } = nearest(e.clientX)
          setDrag({ a: t, b: t })
        }}
        onPointerUp={() => {
          if (drag && Math.abs(X(drag.b) - X(drag.a)) > 10) onZoom([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)])
          setDrag(null)
        }}
        onDoubleClick={() => onZoom && onZoom(null)}
        onKeyDown={(e) => {
          const visible = ts.map((t, i) => (inView[i] ? i : -1)).filter((i) => i >= 0)
          if (!visible.length) return
          const pos = visible.indexOf(at)
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault()
            const next = pos < 0 ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, pos + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1)))
            onHover(ts[visible[next]])
          }
          if (e.key === "Escape") onHover(null)
        }}
        onBlur={() => onHover(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} className="chart-svg">
            {yTicks.map((v, i) => (
              <g key={i}>
                <line x1={AXIS_W} x2={width - 8} y1={Y(v)} y2={Y(v)} className={i === 0 ? "chart-base" : "chart-rule"}></line>
                <text x={AXIS_W - 10} y={Y(v) + 4} className="chart-tick" textAnchor="end">{K.tick(v)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} x={X(t / 1000)} y={height - 6} className="chart-tick" textAnchor="middle">{label(t)}</text>
            ))}
            {gapRects.map(([a, b], i) => (
              <rect key={i} x={X(a)} width={Math.max(1, X(b) - X(a))} y={6} height={plotH - 6} className="chart-gap"></rect>
            ))}
            <clipPath id={clipId}><rect x={AXIS_W} y={0} width={plotW} height={plotH + 2}></rect></clipPath>
            <g clipPath={`url(#${clipId})`}>
              {paths.map(({ s, band }) => band.map((d, i) => <path key={`${s.key}b${i}`} d={d} fill={s.color} className="chart-band"></path>))}
              {paths.map(({ s, area }) => (s.area === false ? null : area.map((d, i) => <path key={`${s.key}a${i}`} d={d} fill={s.color} className="chart-area"></path>)))}
              {paths.map(({ s, line }) => line.map((d, i) => <path key={`${s.key}l${i}`} d={d} stroke={s.color} className="chart-line" strokeDasharray={s.dash}></path>))}
              {loss && ts.map((t, i) => (loss[i] && inView[i] ? <rect key={`x${i}`} x={X(t) - 1} width={2.5} y={Y(0) - Math.min(18, 3 + loss[i] * 0.8)} height={Math.min(18, 3 + loss[i] * 0.8)} className="chart-loss"></rect> : null))}
            </g>
            {drag && <rect x={Math.min(X(drag.a), X(drag.b))} width={Math.abs(X(drag.b) - X(drag.a))} y={6} height={plotH - 6} className="chart-brush"></rect>}
            {hoverX != null && (
              <g>
                <line x1={hoverX} x2={hoverX} y1={6} y2={Y(0)} className="chart-cross"></line>
                {shown.map((s) => (s.values[at] != null ? <circle key={s.key} cx={hoverX} cy={Y(s.values[at])} r={4} fill={s.color} className="chart-dot"></circle> : null))}
              </g>
            )}
          </svg>
        )}
        {nothing && <div className="chart-empty">{empty || T("此时段没有数据")}</div>}
        {hoverX != null && !nothing && (
          <div className="chart-tip" style={{ left: tipLeft ? undefined : hoverX + 12, right: tipLeft ? width - hoverX + 12 : undefined }}>
            <div className="chart-tip-time">{fmt.full(ts[at] * 1000)}</div>
            {shown.map((s) => (
              <div className="chart-tip-row" key={s.key}>
                <i style={{ background: s.color }}></i>
                <strong>{s.values[at] == null ? "—" : K.value(s.values[at])}</strong>
                <span>{s.label}</span>
              </div>
            ))}
            {loss && loss[at] ? <div className="chart-tip-row is-loss"><i></i><strong>{loss[at]}%</strong><span>{T("丢包")}</span></div> : null}
          </div>
        )}
      </div>
      {/* Every chart keeps a legend row, so charts side by side line up. It
          reads the value under the crosshair, or else the latest one. */}
      <div className="chart-legend">
        {series.map((s) => {
          const off = hidden.includes(s.key)
          const v = at >= 0 ? s.values[at] : s.values.filter((x) => x != null).slice(-1)[0]
          const Tag = onToggle ? "button" : "span"
          return (
            <Tag key={s.key} type={onToggle ? "button" : undefined} className={cx("legend-item", off && "is-off")} aria-pressed={onToggle ? !off : undefined} onClick={onToggle ? () => onToggle(s.key) : undefined}>
              <i style={{ background: s.color }} className={s.dash ? "is-dashed" : ""}></i>
              <span>{s.label}</span>
              <strong>{s.status || (v == null ? "—" : K.value(v))}</strong>
            </Tag>
          )
        })}
      </div>
    </figure>
  )
}

// The same history as rows, for reading exact values.
function HistoryTable({ ts, charts }) {
  const cols = charts.flatMap((c) => c.series.map((s) => ({ ...s, kind: c.kind, chart: c.title })))
  const rows = ts.map((t, i) => ({ t, i })).reverse().slice(0, 120)
  return (
    <div className="history-table-wrap" tabIndex={0} role="region" aria-label={T("历史数据表")}>
      <table className="data-table history-table">
        <thead>
          <tr>
            <th scope="col">{T("时间")}</th>
            {cols.map((c) => <th scope="col" key={`${c.chart}-${c.key}`}>{c.chart === c.label ? c.label : `${c.chart} · ${c.label}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, i }) => (
            <tr key={t}>
              <th scope="row" className="mono">{fmt.full(t * 1000)}</th>
              {cols.map((c) => <td key={`${c.chart}-${c.key}`} className="num">{c.values[i] == null ? "—" : KIND[c.kind].value(c.values[i])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The billing period's usage against its quota, with where the current pace
// would end the period.
function QuotaBar({ node, threshold = 80, compact }) {
  const used = fmt.monthUsage(node)
  const limit = node.traffic_limit
  const pct = limit > 0 ? (used / limit) * 100 : null
  const proj = limit > 0 ? fmt.projection(node) : null
  const projPct = proj ? (proj.value / limit) * 100 : null
  const tone = pct == null ? "normal" : pct >= 100 ? "critical" : pct >= threshold ? "warning" : "normal"
  const projTone = projPct != null && projPct >= 100 ? "critical" : projPct != null && projPct >= threshold ? "warning" : "normal"
  return (
    <div className={cx("quota", compact && "quota-compact")} data-tone={tone}>
      <div className="quota-row">
        <span className="quota-label">{T("本期流量")}</span>
        <span className="quota-value num">
          {limit > 0 ? fmt.pair(used, limit) : `${fmt.bytes(used)}`}
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
          <span>{proj ? <>{T("预计")} <b className={projTone !== "normal" ? `ink-${projTone}` : ""}>{fmt.bytes(proj.value)}</b></> : pct != null ? `${pct.toFixed(0)}%` : fmt.MODES[node.traffic_mode]}</span>
          <span>{T("{date}重置", { date: fmt.shortDate(fmt.nextReset(node.traffic_reset_day || 1)) })}</span>
        </div>
      )}
    </div>
  )
}

function Ring({ value, max = 1, size = 44, stroke = 4, tone = "accent", children, label }) {
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

Object.assign(window, { useWidth, Sparkline, HistoryChart, HistoryTable, QuotaBar, Ring, KIND, monotonePath })
