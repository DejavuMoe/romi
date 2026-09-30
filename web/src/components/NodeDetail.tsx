import { useEffect, useRef, useState, type ReactNode } from "react"

import { place } from "../../../shared/geo.ts"
import { T } from "../../../shared/i18n.ts"
import { api, spark, type Node, type Spark } from "../lib/api"
import { bandwidth, bytes, continuousUptime, cycle, expiry, FOREVER, full, MODES, osName, pair, price, tone, uptime } from "../lib/format"
import { cx, useNow } from "../lib/hooks"
import { HistoryChart, HistoryTable, QuotaBar, Ring, Sparkline, type ChartKind, type ChartSeries } from "./charts"
import { nodeFacts, outage, systemLine } from "./Fleet"
import { Globe } from "./Globe"
import { Button, Segmented, Switch, Tabs } from "./ui/controls"
import { CopyValue, Empty, Notice, Skeleton } from "./ui/feedback"
import { Icon, type IconName } from "./ui/icon"
import { AnimatedNumber, FlowValue, LocalSky, Region, StatusBadge } from "./ui/status"

type Point = {
  ts: number
  step?: number
  cpu: number | null
  mem_used: number | null
  disk_used: number | null
  net_rx: number | null
  net_tx: number | null
  procs?: number | null
  tcp?: number | null
  udp?: number | null
  zram_used?: number | null
  swap_disk_used?: number | null
}
// `latency` is the bucket's median round trip, null when every probe in it timed
// out. `band` is the range its answers spanned, absent when they spanned nothing.
// `loss` is the percentage that timed out, absent when none did.
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
type History = {
  metrics: Point[]
  ping: PingPoint[]
  /** Probe names by id, sent alongside the samples they label. */
  probes: Record<string, string>
  /**
   * Proportion of the whole window each probe lost, by id, absent for probes
   * that lost nothing. Sent because it cannot be derived here: every bucket's
   * `loss` is already a percentage of that bucket, so the sample counts it was
   * divided by are unavailable. Averaging them would weight a bucket holding one
   * sample equally with one holding twelve.
   */
  loss?: Record<string, number>
}

const RANGES = [
  { hours: 1, label: "1 小时" },
  { hours: 6, label: "6 小时" },
  { hours: 24, label: "24 小时" },
  { hours: 168, label: "7 天" },
]
const ADMIN_RANGES = [...RANGES, { hours: 720, label: "30 天" }, { hours: 2160, label: "90 天" }, { hours: 8760, label: "1 年" }]
// Latency stops at a day: these are the windows in which every ping remains on
// the chart, and a week of probe history is outside this page's purpose.
const LATENCY_RANGES = RANGES.filter((r) => r.hours <= 24)

type Tab = "resources" | "traffic" | "latency"

/**
 * Hampel filter (Hampel 1974). A point more than `sigmas` robust deviations
 * from its window's median is replaced by that median, while everything else
 * passes through unchanged, which is what distinguishes it from a rolling
 * median or a moving average. 1.4826 rescales the median absolute deviation to
 * a standard deviation for normally distributed data.
 */
function despike(values: (number | null)[], window = 7, sigmas = 3): (number | null)[] {
  const half = window >> 1
  const med = (xs: number[]) => {
    const s = xs.slice().sort((a, b) => a - b)
    return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null
  }
  return values.map((v, i) => {
    // A timeout is a gap rather than a high reading: neither smoothed, nor
    // counted towards what its neighbours are compared against.
    if (v == null) return v
    const near = values.slice(Math.max(0, i - half), i + half + 1).filter((x): x is number => x != null)
    const mid = med(near) ?? v
    const mad = med(near.map((x) => Math.abs(x - mid))) ?? 0
    return mad > 0 && Math.abs(v - mid) > sigmas * 1.4826 * mad ? mid : v
  })
}

/** The smallest spacing between samples, which is the bucket width. */
function stepOf(ts: number[], fallback = 60) {
  let step = Infinity
  for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) step = Math.min(step, ts[i] - ts[i - 1])
  return Number.isFinite(step) ? step : fallback
}

/**
 * The node's history for one window. The first answer replaces nothing; a
 * later refresh keeps what is on screen until it lands, and a failed one keeps
 * it too, with the error beside it. The next refresh is scheduled a minute
 * after the previous one completes, so a slow query never overlaps itself.
 */
function useHistory(id: number, hours: number, series: "metrics" | "ping") {
  const key = `${id}/${hours}/${series}`
  const [state, setState] = useState<{ key: string; data: History | null; error: string; busy: boolean }>({ key: "", data: null, error: "", busy: false })
  const again = useRef<() => void>(() => {})
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    // What this screen can resolve, in device pixels, which is the unit the line
    // is drawn in. The hub only thins further, so an approximate figure suffices.
    const points = Math.round(innerWidth * (devicePixelRatio || 1))
    const load = async (refresh: boolean) => {
      if (inFlight || controller.signal.aborted) return
      clearTimeout(timer)
      inFlight = true
      if (refresh) setState((s) => ({ ...s, busy: true }))
      try {
        const data = await api<History>(`/nodes/${id}/metrics?hours=${hours}&points=${points}&series=${series}`, { signal: controller.signal })
        if (!controller.signal.aborted) setState({ key, data, error: "", busy: false })
      } catch (e) {
        // Kept apart from an empty answer: a refused request and an empty window
        // are different, and the hub has reason to refuse this one -- it caps
        // concurrent history queries over its reader pool.
        if (!controller.signal.aborted) setState((s) => ({ key, data: s.key === key ? s.data : null, error: (e as Error).message || T("网络错误"), busy: false }))
      } finally {
        inFlight = false
        if (!controller.signal.aborted) timer = setTimeout(() => void load(true), 60_000)
      }
    }
    again.current = () => void load(true)
    void load(false)
    return () => {
      controller.abort()
      clearTimeout(timer)
      again.current = () => {}
    }
  }, [id, hours, series, key])
  // Another window's answer is none of this one's.
  const current = state.key === key
  return { data: current ? state.data : null, error: current ? state.error : "", busy: !current || state.busy, retry: () => again.current() }
}

function VitalTile({ icon, label, value, unit, sub, tone: level, trend, get, max, beat, color }: {
  icon: IconName
  label: string
  value: number | ReactNode | null
  unit?: string
  sub: ReactNode
  tone?: string
  trend?: Spark[]
  get?: (p: Spark) => number | null
  max?: number
  beat?: number
  color?: string
}) {
  return (
    <div className="vital" data-tone={level}>
      <div className="vital-head">
        <span className="vital-label"><Icon name={icon} size={14} />{label}</span>
      </div>
      <div className="vital-value num">
        {value == null ? "—" : typeof value === "number" ? <AnimatedNumber value={value} format={(v) => (unit === "%" ? v.toFixed(0) : String(Math.round(v)))} /> : value}
        {value != null && unit && <span className="unit">{unit}</span>}
      </div>
      <div className="vital-sub">{sub}</div>
      {trend && get && <Sparkline points={trend} get={get} max={max} beat={beat} height={30} color={color} />}
    </div>
  )
}

function Fact({ label, children, mono }: { label: string; children?: ReactNode; mono?: boolean }) {
  if (children === null || children === undefined || children === "") return null
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{children}</dd>
    </div>
  )
}

const CYCLE_DAYS: Record<string, number> = { monthly: 30, quarterly: 91, semiannual: 182, yearly: 365, biennial: 730, triennial: 1095 }

function BillingPanel({ node }: { node: Node }) {
  const exp = expiry(node)
  const days = CYCLE_DAYS[node.billing_cycle] || 30
  const left = exp.days == null ? null : Math.max(0, exp.days)
  return (
    <section className="panel" aria-labelledby="billing-title">
      <h2 id="billing-title" className="panel-title"><Icon name="wallet" size={16} />{T("账单")}</h2>
      <div className="billing-main">
        <Ring value={left ?? days} max={days} size={64} stroke={5} tone={exp.tone === "bad" ? "bad" : exp.tone === "warn" ? "warn" : exp.days == null ? "muted" : "accent"}>
          {exp.days == null ? "∞" : exp.days < 0 ? "!" : exp.days}
        </Ring>
        <div className="billing-text">
          <strong className="num">{price(node)}</strong>
          <span className={`ink-${exp.tone}`}>{exp.text}</span>
        </div>
      </div>
      <dl className="facts">
        <Fact label={T("到期日期")}>{node.expires_at || T(FOREVER)}</Fact>
        <Fact label={T("付款周期")}>{cycle(node.billing_cycle)}</Fact>
      </dl>
    </section>
  )
}

function TrafficPanel({ node, threshold }: { node: Node; threshold: number }) {
  return (
    <section className="panel" aria-labelledby="traffic-title">
      <h2 id="traffic-title" className="panel-title"><Icon name="arrow-down-up" size={16} />{T("流量")}</h2>
      <QuotaBar node={node} threshold={threshold} />
      <dl className="facts facts-2">
        <Fact label={T("计费方式")}>{T(MODES[node.traffic_mode] ?? MODES.sum)}</Fact>
        <Fact label={T("每月重置日")}>{T("{n} 日", { n: node.traffic_reset_day || 1 })}</Fact>
        <Fact label={T("今日下载 / 上传")}><span className="num">{bytes(node.day_rx)} / {bytes(node.day_tx)}</span></Fact>
        <Fact label={T("累计下载 / 上传")}><span className="num">{bytes(node.total_rx)} / {bytes(node.total_tx)}</span></Fact>
        <Fact label={T("可用带宽 · 下载 / 上传")}>{`${bandwidth(node.bandwidth_down)} / ${bandwidth(node.bandwidth_up)}`}</Fact>
      </dl>
    </section>
  )
}

function SystemPanel({ node, admin }: { node: Node; admin: boolean }) {
  // The address the Agent connected from stands in for a family it did not report.
  const v6 = node.ip?.includes(":")
  return (
    <section className="panel" aria-labelledby="system-title">
      <h2 id="system-title" className="panel-title"><Icon name="server" size={16} />{T("系统")}</h2>
      <dl className="facts facts-2">
        <Fact label={T("系统")}>{node.os ? osName(node.os) : T("待上报")}</Fact>
        <Fact label={T("内核")} mono>{node.kernel || "—"}</Fact>
        <Fact label={T("架构")} mono>{node.arch || "—"}</Fact>
        <Fact label={T("虚拟化")}>{node.virt ? node.virt.toUpperCase() : "—"}</Fact>
        <Fact label="CPU">{node.cpu_name ? `${node.cpu_name} · ${node.cpu_cores} vCPU` : T("待上报")}</Fact>
        <Fact label={T("内存 / Swap")}><span className="num">{node.mem_total ? bytes(node.mem_total) : "—"} / {node.swap_total ? bytes(node.swap_total) : T("未启用")}</span></Fact>
        <Fact label={T("磁盘")}><span className="num">{node.disk_total ? bytes(node.disk_total) : "—"}</span></Fact>
        <Fact label={T("Agent 版本")} mono>{node.agent_version || T("未上报")}</Fact>
      </dl>
      {admin && (
        <dl className="facts facts-2 facts-admin">
          <Fact label="IPv4"><CopyValue value={node.ipv4 || (v6 ? undefined : node.ip)} label=" IPv4" /></Fact>
          <Fact label="IPv6"><CopyValue value={node.ipv6 || (v6 ? node.ip : undefined)} label=" IPv6" /></Fact>
          <Fact label={T("接入标识")}><CopyValue value={`node-${node.id}`} label={T("接入标识")} /></Fact>
          <Fact label={T("备注")}>{node.remark || "—"}</Fact>
        </dl>
      )}
    </section>
  )
}

function HistorySection({ node, admin }: { node: Node; admin: boolean }) {
  const [tab, setTab] = useState<Tab>("resources")
  // Each tab keeps its own range: a 7-day trend and a 1-hour trace answer
  // different questions.
  const [ranges, setRanges] = useState<Record<Tab, number>>({ resources: 24, traffic: 24, latency: 6 })
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const [smooth, setSmooth] = useState(false)
  const hours = ranges[tab]
  const { data, error, busy, retry } = useHistory(node.id, hours, tab === "latency" ? "ping" : "metrics")
  // Held as times rather than sample positions, so the minute refresh leaves it
  // on the same moments. It belongs to one tab and range.
  const view = `${tab}/${hours}`
  const [zoomAt, setZoomAt] = useState<{ view: string; range: [number, number] } | null>(null)
  const zoom = zoomAt?.view === view ? zoomAt.range : null
  const setZoom = (range: [number, number] | null) => setZoomAt(range ? { view, range } : null)
  const available = tab === "latency" ? LATENCY_RANGES : admin ? ADMIN_RANGES : RANGES

  const metrics = data?.metrics ?? []
  const ping = data?.ping ?? []
  const now = useNow(60_000)
  const last = Math.max(0, ...(tab === "latency" ? ping : metrics).map((p) => p.ts))
  const end = Math.max(Math.floor(now / 60_000) * 60, last)
  const domain: [number, number] = zoom || [end - hours * 3600, end]

  const ts = metrics.map((p) => p.ts)
  const step = metrics[0]?.step ?? stepOf(ts)
  const m = node.online ? node.metrics : null
  const off = (enabled: boolean | undefined) => (enabled === false ? T("未启用") : null)
  const charts: { title: string; kind: ChartKind; wide?: boolean; max?: number; series: ChartSeries[] }[] =
    tab === "resources"
      ? [
          { title: "CPU", kind: "percent", series: [{ key: "cpu", label: "CPU", color: "var(--trend)", values: metrics.map((p) => p.cpu) }] },
          {
            title: T("内存"),
            kind: "bytes",
            // Swap can outgrow the physical memory it backs.
            max: Math.max(node.mem_total, m?.swap_disk_total ?? 0) || undefined,
            series: [
              { key: "ram", label: "RAM", color: "var(--trend)", values: metrics.map((p) => p.mem_used) },
              { key: "zram", label: "ZRAM", color: "var(--series-3)", dash: "5 3", area: false, values: metrics.map((p) => p.zram_used), status: off(m ? m.zram_devices !== 0 : undefined) },
              { key: "swap", label: "Swap", color: "var(--series-4)", dash: "2 3", area: false, values: metrics.map((p) => p.swap_disk_used), status: off(m ? m.swap_disk_total !== 0 : undefined) },
            ],
          },
          { title: T("磁盘"), kind: "percent", series: [{ key: "disk", label: T("磁盘"), color: "var(--trend)", values: metrics.map((p) => (p.disk_used == null || !node.disk_total ? null : (p.disk_used / node.disk_total) * 100)) }] },
          { title: T("进程数"), kind: "count", series: [{ key: "procs", label: T("进程"), color: "var(--trend)", values: metrics.map((p) => p.procs) }] },
          {
            title: T("TCP / UDP 连接"),
            kind: "count",
            series: [
              { key: "tcp", label: "TCP", color: "var(--trend)", values: metrics.map((p) => p.tcp) },
              { key: "udp", label: "UDP", color: "var(--series-3)", area: false, values: metrics.map((p) => p.udp) },
            ],
          },
        ]
      : tab === "traffic"
        ? [
            {
              title: T("网络速率"),
              kind: "rate",
              wide: true,
              series: [
                { key: "rx", label: T("下载"), color: "var(--flow-down)", values: metrics.map((p) => p.net_rx) },
                { key: "tx", label: T("上传"), color: "var(--flow-up)", values: metrics.map((p) => p.net_tx) },
              ],
            },
          ]
        : []

  // One chart per probe that reported, labelled from the names the samples
  // arrived with. Timeouts are kept: dropping them would draw a probe losing
  // half its packets as an unbroken line.
  const probes = [...new Set(ping.map((p) => p.task_id))].map((id) => {
    const rows = ping.filter((p) => p.task_id === id)
    return { id, name: data?.probes?.[id] ?? T("探测 {id}", { id }), rows, loss: data?.loss?.[id] ?? 0 }
  })

  const inWindow = (t: number) => t >= domain[0] && t <= domain[1]
  // Transfer inside the visible window, from the bucket rates.
  const moved = (k: "net_rx" | "net_tx") => metrics.reduce((t, p) => (inWindow(p.ts) ? t + (p[k] ?? 0) * (p.step ?? step) : t), 0)
  const peak = (values: (number | null | undefined)[]) => Math.max(0, ...values.filter((v, i): v is number => v != null && inWindow(ts[i])))
  // An odd count would leave the last row half empty, so the first chart takes
  // the whole row and the rest pair up.
  const lead = (count: number, i: number) => count % 2 === 1 && i === 0
  const summary = (c: (typeof charts)[number]) =>
    c.kind === "percent"
      ? T("峰值 {pct}%", { pct: peak(c.series[0].values).toFixed(0) })
      : c.kind === "rate"
        ? T("此时段 ↓ {down} · ↑ {up}", { down: bytes(moved("net_rx")), up: bytes(moved("net_tx")) })
        : c.kind === "bytes"
          ? T("物理内存 {size}", { size: bytes(node.mem_total) })
          : T("峰值 {value}", { value: peak(c.series[0].values) })

  const nothing = tab === "latency" ? !probes.length : !metrics.length
  const tabs: { value: Tab; label: string; icon: IconName }[] = [
    { value: "resources", label: T("资源"), icon: "cpu" },
    { value: "traffic", label: T("流量"), icon: "arrow-down-up" },
    { value: "latency", label: T("监测"), icon: "radar" },
  ]
  const skeletons = tab === "resources" ? 5 : 1

  let body: ReactNode
  if (!data)
    body = error ? (
      <Empty error title={T("历史加载失败")} detail={error} action={T("重试")} onAction={retry} />
    ) : (
      <div className="chart-grid" role="status" aria-label={T("正在加载")}>
        {Array.from({ length: skeletons }, (_, i) => <Skeleton key={i} className={cx("chart-skeleton", lead(skeletons, i) && "is-lead")} />)}
      </div>
    )
  else if (nothing)
    body = <Empty icon="history" title={T("暂无历史数据")} detail={tab === "latency" ? T("此节点没有分配监测任务，或还没有结果。") : T("收到采样后，历史会显示在这里。")} />
  else if (asTable)
    body = tab === "latency" ? (
      <HistoryTable ts={(probes[0]?.rows ?? []).map((r) => r.ts)} charts={probes.map((p) => ({ title: p.name, kind: "ms", series: [{ key: "latency", label: T("延迟"), color: "var(--trend)", values: p.rows.map((r) => r.latency) }] }))} />
    ) : (
      <HistoryTable ts={ts} charts={charts} />
    )
  else if (tab === "latency")
    body = (
      <div className="chart-grid">
        {probes.map((p, i) => {
          const rowTs = p.rows.map((r) => r.ts)
          const raw = p.rows.map((r) => r.latency)
          // The band stays raw: it exists to show what the smoothed line omits.
          const values = smooth ? despike(raw) : raw
          const answered = values.filter((v): v is number => v != null).sort((a, b) => a - b)
          const med = answered[Math.floor(answered.length / 2)]
          return (
            <HistoryChart
              key={p.id}
              lead={lead(probes.length, i)}
              height={lead(probes.length, i) ? 208 : 176}
              title={p.name}
              // Unrounded below 1%, since rounding would render 0.28% and 0.00%
              // as the same figure.
              summary={T("中位 {ms} ms · 丢包 {loss}%", { ms: med ? Math.round(med) : "—", loss: p.loss.toFixed(p.loss < 1 ? 2 : 1) })}
              ts={rowTs}
              kind="ms"
              step={stepOf(rowTs)}
              domain={domain}
              hover={hover != null && rowTs.includes(hover) ? hover : null}
              onHover={setHover}
              onZoom={setZoom}
              loss={p.rows.map((r) => r.loss ?? 0)}
              series={[{ key: "latency", label: T("延迟"), color: "var(--trend)", values, band: p.rows.map((r) => r.band ?? null), area: false }]}
            />
          )
        })}
      </div>
    )
  else
    body = (
      <div className="chart-grid">
        {charts.map((c, i) => (
          <HistoryChart
            key={c.title}
            lead={lead(charts.length, i)}
            title={c.title}
            summary={summary(c)}
            ts={ts}
            kind={c.kind}
            step={step}
            domain={domain}
            hover={hover}
            onHover={setHover}
            onZoom={setZoom}
            height={c.wide ? 260 : lead(charts.length, i) ? 208 : 176}
            max={c.max}
            series={c.series}
          />
        ))}
      </div>
    )

  return (
    <section className="history" aria-labelledby="history-title">
      <div className="history-bar">
        <h2 id="history-title" className="section-title">{T("历史")}</h2>
        <Tabs tabs={tabs} value={tab} onChange={setTab} label={T("历史类型")} idPrefix="history" />
        <div className="history-tools">
          <Segmented
            size="sm"
            label={T("时间范围")}
            value={String(hours)}
            onChange={(v) => setRanges({ ...ranges, [tab]: Number(v) })}
            options={available.map((r) => ({ value: String(r.hours), label: T(r.label) }))}
          />
          {tab === "latency" && <Switch checked={smooth} onChange={setSmooth} label={T("平滑")} />}
          <Segmented
            size="sm"
            label={T("历史显示方式")}
            value={asTable ? "table" : "chart"}
            onChange={(v) => setAsTable(v === "table")}
            options={[{ value: "chart", label: T("图表") }, { value: "table", label: T("表格") }]}
          />
        </div>
      </div>
      {zoom && (
        <div className="zoom-note">
          <Icon name="search" size={14} />
          <span className="num">{full(zoom[0] * 1000)} – {full(zoom[1] * 1000)}</span>
          <button type="button" className="link-button" onClick={() => setZoom(null)}>{T("恢复完整范围")}</button>
        </div>
      )}
      {data && error && (
        <Notice tone="bad" action={<Button size="sm" icon="refresh-cw" busy={busy} onClick={retry}>{T("重试")}</Button>}>
          {T("历史刷新失败：{error}。当前显示上次成功读取的数据。", { error })}
        </Notice>
      )}
      <div id={`history-panel-${tab}`} role="tabpanel" aria-labelledby={`history-${tab}`} className={cx("history-body", data && busy && "is-loading")}>
        {body}
      </div>
      <p className="history-hint">{T("在图表上拖动可放大，双击恢复。")}</p>
    </section>
  )
}

/**
 * One node: vitals now, the billing period, the machine, and its history. The
 * panel passes `admin` for the long ranges and the fields only it receives.
 */
export function NodeDetail({ node, beat, theme, admin = false, onBack, backLabel, backHref = "/", onManage, threshold = 80 }: {
  node: Node
  beat?: number
  theme?: string
  admin?: boolean
  onBack: () => void
  backLabel?: string
  backHref?: string
  onManage?: (node: Node) => void
  threshold?: number
}) {
  const f = nodeFacts(node)
  const at = place(node.country)
  const down = outage(node)
  const trend = spark(node.id)
  const m = f.m
  return (
    <article className="detail" data-status={f.status}>
      <a className="back-link" href={backHref} onClick={(e) => { e.preventDefault(); onBack() }}>
        <Icon name="arrow-left" size={16} />
        {backLabel ?? T("全部节点")}
      </a>
      <header className="detail-head" style={{ viewTransitionName: `node-${node.id}` }}>
        <div className="detail-id">
          <div className="detail-where">
            {node.country ? <Region code={node.country} full /> : <span className="muted">{T("未定位")}</span>}
            <LocalSky code={node.country} text />
            {admin && !node.public && <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>}
          </div>
          <h1 className="detail-name">{node.name}</h1>
          <div className="detail-line">
            <StatusBadge node={node} beat={beat} />
            <span className="detail-meta">{systemLine(node)}</span>
          </div>
          <p className="detail-uptime num">
            <span>{T("连续在线")} <b>{continuousUptime(node)}</b></span>
            <span>{T("本次启动")} <b>{m ? uptime(m.uptime) : "—"}</b></span>
            {!node.online && node.last_seen > 0 && <span>{T("最后上报")} <b>{full(node.last_seen * 1000)}</b></span>}
          </p>
          {onManage && (
            <div className="detail-actions">
              <Button kind="primary" icon="sliders-horizontal" onClick={() => onManage(node)}>{T("管理节点")}</Button>
            </div>
          )}
        </div>
        {at && <Globe variant="detail" nodes={[node]} lon={at[0]} lat={at[1]} size={216} theme={theme} beat={beat} />}
      </header>
      {down && <Notice tone={down.tone} icon={down.tone === "bad" ? "wifi-off" : "loader-circle"}>{T("{text}。历史数据仍可查看。", { text: down.text })}</Notice>}
      {f.status === "never" && <Notice icon="clock">{T("此节点还没有上报。安装 Agent 后，实时数据和历史会显示在这里。")}</Notice>}
      <div className="vitals">
        <VitalTile icon="cpu" label="CPU" value={f.cpu} unit="%" tone={tone(f.cpu)} sub={m ? T("负载 {load}", { load: m.load.map((v) => v.toFixed(2)).join(" · ") }) : node.cpu_cores ? `${node.cpu_cores} vCPU` : T("待上报")} trend={trend} get={(p) => p.cpu} max={100} beat={beat} color="var(--trend)" />
        <VitalTile icon="memory-stick" label={T("内存")} value={f.mem} unit="%" tone={tone(f.mem)} sub={m ? `${pair(m.mem_used, m.mem_total)}${(m.zram_total ?? 0) > 0 ? ` · ZRAM ${bytes(m.zram_used ?? 0)}` : ""}${m.swap_total > 0 ? ` · Swap ${bytes(m.swap_used)}` : ""}` : T("待上报")} trend={trend} get={(p) => p.mem} max={100} beat={beat} color="var(--trend)" />
        <VitalTile icon="hard-drive" label={T("磁盘")} value={f.disk} unit="%" tone={tone(f.disk)} sub={m ? pair(m.disk_used, m.disk_total) : T("待上报")} />
        <VitalTile icon="arrow-down-up" label={T("网络")} value={m ? <span className="vital-rates"><FlowValue dir="down" value={m.net_rx} /><FlowValue dir="up" value={m.net_tx} /></span> : null} sub={T("带宽 {bandwidth}", { bandwidth: bandwidth(node.bandwidth_down) })} trend={trend} get={(p) => p.rx} beat={beat} color="var(--flow-down)" />
        <VitalTile icon="network" label={T("连接")} value={m ? <span className="vital-pair"><span>TCP <b>{m.tcp}</b></span><span>UDP <b>{m.udp}</b></span></span> : null} sub={T("当前连接数")} />
        <VitalTile icon="activity" label={T("进程")} value={m ? m.procs : null} sub={T("当前进程数")} />
      </div>
      <div className="panels">
        <TrafficPanel node={node} threshold={threshold} />
        <BillingPanel node={node} />
        <SystemPanel node={node} admin={admin} />
      </div>
      <HistorySection key={node.id} node={node} admin={admin} />
    </article>
  )
}
