import { useEffect, useMemo, useRef, useState } from "react"
import { median } from "d3-array"
import {
  Area, Brush, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts"

import { usageTone } from "../../../shared/usage"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../admin/src/components/ui/select"
import { Button } from "./ui/button"
import { Skeleton } from "./ui/skeleton"
import { Country, Status } from "./NodeCard"
import { api, type Node } from "../lib/api"
import {
  axisBytes, continuousUptime, bytes, clockFor, monthUsage, percent, uptime, osName, timeTicks, withHistoryGaps,
} from "../lib/format"

type Point = {
  step?: number
  procs?: number | null
  tcp?: number | null
  udp?: number | null
  zram_used?: number | null
  swap_disk_used?: number | null
  swapfile_used?: number | null
  swap_partition_used?: number | null
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
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
/** Probe names by id, sent alongside the samples they label. */
type Probes = Record<string, string>
/**
 * Proportion of the whole window each probe lost, by id, absent for probes that
 * lost nothing. Sent because it cannot be derived here: every bucket's `loss` is
 * already a percentage of that bucket, so the sample counts it was divided by are
 * unavailable. Averaging them would weight a bucket holding one sample equally
 * with one holding twelve, and the window's first and last buckets are partial
 * regardless of what the probe does.
 */
type Loss = Record<string, number>

const RANGES = [
  { hours: 1, label: "1 小时" },
  { hours: 6, label: "6 小时" },
  { hours: 24, label: "24 小时" },
  { hours: 168, label: "7 天" },
]

// Latency stops at a day. A week-wide bucket would still carry the spread and the
// loss figure, but a week of probe history is outside this page's purpose, and
// these are the windows in which every ping remains on the chart.
const RANGES_FOR = { resources: RANGES, traffic: RANGES, latency: RANGES.filter((r) => r.hours <= 24) }
const ADMIN_RANGES = [...RANGES, { hours: 720, label: "30 天" }, { hours: 2160, label: "90 天" }, { hours: 8760, label: "1 年" }]

const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false }

// No grow-in animation: it would spend 1.5 s drawing a line across the panel on
// every range change, on a page meant to be read at a glance, and on the latency
// chart across seven hundred points per probe.
const TOOLTIP_STYLE = { maxWidth: "calc(100vw - 32px)", overflowWrap: "anywhere" as const, whiteSpace: "normal" as const, fontSize: 12, background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 0, boxShadow: "none" }

const SERIES = { dot: false as const, strokeWidth: 1.25, isAnimationActive: false }

// One width for every stacked panel's value axis. Sized to their own labels --
// 40px under "100%", 68px under "172 MB" -- the four plot areas would be offset by
// 28px, placing a CPU spike and the network spike that caused it at different x.
const Y_WIDTH = 68

// Series retain both a color and a line pattern in either theme.
const PALETTE = [
  { stroke: "var(--color-chart-1)", dash: undefined },
  { stroke: "var(--color-chart-5)", dash: "6 3" },
  { stroke: "var(--color-chart-3)", dash: "2 3" },
  { stroke: "var(--color-chart-4)", dash: "10 4 2 4" },
  { stroke: "var(--color-chart-5)", dash: "1 4" },
]

const TABS = [
  { key: "resources", label: "资源" },
  { key: "latency", label: "监测" },
  { key: "traffic", label: "流量" },
] as const

function Panel({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border p-3 sm:p-4">
      <h4 className="mb-3 text-sm font-medium">{title}</h4>
      <div className="h-48 w-full text-muted-foreground sm:h-56">{children}</div>
    </div>
  )
}

function Tab({ id, active, controls, onClick, children }: { id: string; active: boolean; controls: string; onClick: () => void; children: string }) {
  return (
    <button
      id={id}
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      // A tab list is one stop, not three: Tab reaches the selected tab and the
      // arrows move between them. See the keydown handler on the list.
      tabIndex={active ? 0 : -1}
      className={`history-tab border-b-2 transition-colors ${
        active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Hampel filter (Hampel 1974; MATLAB ships it as `hampel`). A point more than
 * `sigmas` robust deviations from its window's median is replaced by that median,
 * while everything else passes through unchanged, which is what distinguishes it
 * from a rolling median or a moving average.
 *
 * 1.4826 rescales the median absolute deviation to a standard deviation for
 * normally distributed data; 3 sigma is the conventional cut.
 */
function despike(points: PingPoint[], window = 7, sigmas = 3): PingPoint[] {
  const half = window >> 1
  // ponytail: recomputes the window per point. A few thousand samples is
  // negligible; substitute a rolling structure if a chart ever needs 100k.
  return points.map((p, i) => {
    // A timeout is a gap rather than a high reading: neither smoothed, nor counted
    // towards what its neighbours are compared against.
    if (p.latency === null) return p
    const near = points
      .slice(Math.max(0, i - half), i + half + 1)
      .map((x) => x.latency)
      .filter((v) => v !== null)
    const mid = median(near) ?? p.latency
    const mad = median(near.map((v) => Math.abs(v - mid))) ?? 0
    const outlier = mad > 0 && Math.abs(p.latency - mid) > sigmas * 1.4826 * mad
    return outlier ? { ...p, latency: mid } : p
  })
}

function Fact({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{value}</dd>
    </div>
  )
}

export function NodeDetail({ node, authed = false }: { node: Node; authed?: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("resources")
  // Each tab keeps its own range: a 7-day trend and a 1-hour trace answer
  // different questions.
  const [ranges, setRanges] = useState({ resources: 24, latency: 6, traffic: 24 })
  const hours = ranges[tab]
  const [smooth, setSmooth] = useState(false)
  // Probes switched off. Hiding a slow one is what makes the fast ones readable,
  // as the axis rescales to what remains.
  const [hiddenProbes, setHiddenProbes] = useState<number[]>([])
  const [data, setData] = useState<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss } | null>(null)
  // Retained rather than folded into an empty result: a refused request and an
  // empty window are different answers, and the hub has reason to refuse this one
  // -- it caps concurrent history queries over its reader pool. Rendered as an
  // empty window, a 503 would misdirect the reader.
  const [failed, setFailed] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useRef<() => void>(() => {})
  // Where the brush has been dragged, so the axis reticks for the visible span
  // rather than retaining the whole window's ticks. Held as times, not row
  // indices: the minute refresh moves a rolling window along, which leaves an
  // index pointing at a different moment -- so the zoom used to be dropped on
  // every refresh instead. An end of `Infinity` is a span pinned to the newest
  // sample, which keeps following it.
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  // Where the chart begins on screen, so its height can occupy the remainder.
  const [chartTop, setChartTop] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let loading = false
    // The charts must not continue drawing the old range while the new one is in
    // flight.
    // oxlint-disable-next-line react/set-state-in-effect
    setData(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setZoom(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    // What this screen can resolve, in device pixels, which is the unit the line
    // is drawn in: a 1280-wide retina panel has 2560 of them for a day of minutes.
    // Read here rather than from a ref, since the hub only thins further, an
    // approximate figure suffices, and the viewport is known before layout. A
    // rotation keeps whatever it fetched with.
    //
    // The tab determines which half is requested; the other accounted for a third
    // to two thirds of every response and was never drawn.
    const points = Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1))
    const series = tab === "latency" ? "ping" : "metrics"
    const load = async () => {
      if (loading || controller.signal.aborted) return
      clearTimeout(timer)
      loading = true
      setRefreshing(true)
      try {
        const next = await api<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss }>(
          `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
          { signal: controller.signal },
        )
        if (!controller.signal.aborted) {
          setData(next)
          setFailed("")
        }
      } catch (e) {
        if (!controller.signal.aborted) setFailed((e as Error).message || "网络错误")
      } finally {
        loading = false
        if (!controller.signal.aborted) {
          setRefreshing(false)
          // History is stored in minute buckets. Schedule after completion so
          // slow queries never overlap, and failures are retried as well.
          timer = setTimeout(load, 60_000)
        }
      }
    }
    refresh.current = () => { void load() }
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
      refresh.current = () => {}
    }
  }, [node.id, hours, tab])

  const m = node.online ? node.metrics : null
  // One series per probe that reported, labelled from the names the samples
  // arrived with. Memoised, as are the two below: the node prop changes every few
  // seconds as live metrics arrive, and rebuilding the chart's data array on those
  // renders would reset the brush.
  const pingSeries = useMemo(
    () =>
      [...new Set((data?.ping ?? []).map((p) => p.task_id))]
        .map((id) => {
          // Timeouts are retained: dropping them would draw a probe losing half
          // its packets as an unbroken line, and one that never answered not at
          // all.
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          // Taken from the hub rather than summed from the buckets above, each of
          // which is already a percentage of its own bucket, so averaging them
          // would report one lost round in thirteen as 50%. Left unrounded, since
          // `Math.round` would render 0.28% and 0.00% as the same badge, and the
          // absence of a badge denotes no loss.
          const loss = data?.loss?.[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        })
        .filter((s) => s.points.length > 0),
    [data],
  )

  // The hub answers in seconds; the time axis requires milliseconds.
  const metricRows = useMemo(
    () => withHistoryGaps(data?.metrics ?? []).map((m) => ({ ...m, ts: m.ts * 1_000 })),
    [data],
  )

  const shownProbes = useMemo(
    () => pingSeries.filter((s) => !hiddenProbes.includes(s.id)),
    [pingSeries, hiddenProbes],
  )
  // Keyed on the full list, so a line keeps its shade when others are hidden.
  const style = (id: number) => PALETTE[pingSeries.findIndex((p) => p.id === id) % PALETTE.length]

  // The hub stamps every sample with its bucket rather than the second the probe
  // finished, so probes reporting at the bucket's rate share rows instead of each
  // contributing its own: a day of four probes is 717 rows rather than 2,868. A
  // slower probe leaves gaps in its own column, which is what `connectNulls`
  // addresses.
  //
  // Every probe and both versions of every sample are held here whether or not
  // they are on screen: recharts resets the brush when the data array changes
  // identity, and re-reads a controlled selection only when the index props
  // change, which they do not. Hiding a probe or enabling despiking therefore
  // selects a `dataKey` rather than rebuilding the array.
  const pingRows = useMemo(() => {
    const rows = new Map<
      number,
      { ts: number } & Record<string, number | [number, number] | null>
    >()
    for (const s of pingSeries) {
      const smoothed = despike(s.points)
      s.points.forEach((p, i) => {
        const row = rows.get(p.ts) ?? { ts: p.ts * 1_000 }
        row[`t${s.id}`] = p.latency
        row[`s${s.id}`] = smoothed[i].latency
        row[`l${s.id}`] = p.loss ?? 0
        // Raw, never despiked: the band exists to show what the line omits, and
        // smoothing it would omit the same points.
        row[`b${s.id}`] = p.band ?? null
        rows.set(p.ts, row)
      })
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts)
  }, [pingSeries])

  // The zoomed span as indices into the rows now on screen, or null for the
  // whole window -- including when the window has rolled past the span
  // entirely, which leaves nothing of it to show.
  const zoomed = useMemo((): [number, number] | null => {
    if (!zoom) return null
    const from = pingRows.findIndex((row) => row.ts >= zoom[0])
    const to = pingRows.findLastIndex((row) => row.ts <= zoom[1])
    return from < 0 || to <= from ? null : [from, to]
  }, [pingRows, zoom])

  // A real time axis rather than the category axis recharts defaults to: on a
  // category axis ticks are selected by index, so a period the agent was offline
  // for collapses to nothing.
  const timeAxis = (rows: { ts: number }[], from = 0, to = rows.length - 1) => ({
    dataKey: "ts",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as const,
    // Explicit, or recharts places them at 05:14 and 10:22. Any that still collide
    // are dropped by `minTickGap`.
    ticks: rows.length ? timeTicks(rows[from].ts, rows[to].ts) : undefined,
    tickFormatter: clockFor(hours),
    minTickGap: hours > 24 ? 72 : 40,
    ...AXIS,
  })

  return (
    <div className="node-detail space-y-4">
      <div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 break-words text-xl font-semibold">{node.name}</h2><Country node={node}/><span className="ml-auto"><Status node={node}/></span></div>
      {/* One list, one separator: a node that has not reported its system
          would otherwise open the line with a stray "·". */}
      <p className="text-xs text-muted-foreground">{[osName(node.os), node.arch, `连续在线 ${continuousUptime(node)}`, `本次启动 ${m ? uptime(m.uptime) : "—"}`].filter(Boolean).join(" · ")}</p>
      <dl className="detail-kpis">{[["CPU",m?.cpu,node.cpu_cores ? `${node.cpu_cores} vCPU`:"待上报"],["RAM",m && m.mem_total>0?percent(m.mem_used,m.mem_total):null,node.mem_total?bytes(node.mem_total):"待上报"],["磁盘",m && m.disk_total>0?percent(m.disk_used,m.disk_total):null,node.disk_total?bytes(node.disk_total):"待上报"]].map(([name,value,foot])=><div key={String(name)}><dt>{name}</dt><dd data-tone={usageTone(value as number|null)} className="usage-number">{value==null?"—":`${Number(value).toFixed(0)}%`}</dd><small>{foot}</small></div>)}<div><dt>本期流量</dt><dd>{bytes(monthUsage(node))}</dd><small>{node.traffic_limit?`/ ${bytes(node.traffic_limit)}`:"不限"}</small></div></dl>
      <dl className="detail-facts">
        <Fact label="系统" value={node.os || "待上报"}/><Fact label="架构" value={node.arch || "待上报"}/><Fact label="内核" value={node.kernel || "待上报"}/>
        <Fact label="可用带宽 · 上传 / 下载" value={`${bandwidth(node.bandwidth_up)} / ${bandwidth(node.bandwidth_down)}`}/><Fact label="Agent 版本" value={node.agent_version || "待上报"}/><Fact label="累计上传 / 下载" value={`${bytes(node.total_tx)} / ${bytes(node.total_rx)}`}/>
        {authed && <Fact label="地址" value={[node.ipv4,node.ipv6,node.ip].filter(Boolean).join(" / ")}/>}
      </dl>

      {node.remark && (
        <p className="bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">{node.remark}</p>
      )}

      <div className="history-controls">
        <div
          className="flex gap-1"
          role="tablist"
          aria-label="历史类型"
          // Arrow/Home/End move the selection and carry focus with it, which is
          // what `role="tab"` already promised. Without it a keyboard user pays
          // three stops to pass the control and gets no arrow behaviour.
          onKeyDown={(event) => {
            const at = TABS.findIndex((t) => t.key === tab)
            const to =
              event.key === "ArrowRight" ? at + 1
              : event.key === "ArrowLeft" ? at - 1
              : event.key === "Home" ? 0
              : event.key === "End" ? TABS.length - 1
              : null
            if (to === null) return
            event.preventDefault()
            const next = TABS[(to + TABS.length) % TABS.length]
            setTab(next.key)
            event.currentTarget.querySelector<HTMLElement>(`#tab-${next.key}`)?.focus()
          }}
        >
          {TABS.map((t) => (
            <Tab
              key={t.key}
              id={`tab-${t.key}`}
              controls={`tabpanel-${t.key}`}
              active={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </Tab>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">时间范围</span><Select value={String(hours)} onValueChange={v=>setRanges(all=>({...all,[tab]:Number(v)}))}><SelectTrigger className="w-32" aria-label="时间范围"><SelectValue/></SelectTrigger><SelectContent>{(authed?ADMIN_RANGES:RANGES_FOR[tab]).map(r=><SelectItem key={r.hours} value={String(r.hours)}>{r.label}</SelectItem>)}</SelectContent></Select></div>
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => refresh.current()}>
            {refreshing ? "刷新中…" : failed ? "重试" : "刷新"}
          </Button>
        </div>
      </div>

      {failed && (
        <p className="text-sm text-destructive" role="alert">
          读取历史数据失败：{failed}{data ? "；当前显示上次成功读取的数据。" : ""}
        </p>
      )}
      {/* The region the tabs switch. It names itself by the tab that selected
          it, so the two are one control rather than two strings that drift. */}
      <div id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {!data ? (
        failed ? null : <Skeleton className="h-40 w-full" />
      ) : tab === "latency" ? (
        pingSeries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有延迟数据</p>
        ) : (
          // An explicit pixel height on the column, so the chart can be `flex-1`
          // within it while the legend takes what it needs: four probes are one row
          // of chips on a desktop and two on a phone, so any fixed reservation is
          // wrong on one of them.
          <div
            // `+ scrollY`, because getBoundingClientRect is measured from the
            // viewport and this callback runs on every render; a live node
            // re-renders every two seconds, so a scrolled page would re-derive the
            // height from a top that has moved.
            ref={(el) => {
              if (el) setChartTop(el.getBoundingClientRect().top + scrollY)
            }}
            style={
              chartTop
                ? { height: `calc(100svh - ${Math.round(chartTop)}px - 1rem)` }
                : undefined
            }
            className="flex min-h-72 flex-col gap-3">
          {tab === "latency" && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => setSmooth(e.target.checked)}
                className="accent-foreground"
              />
              削峰
            </label>
          )}

            {/* `min-h-0` is what makes `flex-1` a real number rather than the
                content's own height: ResponsiveContainer reads its parent, and
                a flex child not told it may shrink reports whatever the SVG
                last was. The column above has a height in pixels, so this
                resolves at layout instead of coming back 0. */}
            <div className="min-h-0 w-full flex-1 text-muted-foreground">
              {shownProbes.length === 0 ? (
                <p className="py-8 text-center text-sm">没有选中任何探测</p>
              ) : (
                <ResponsiveContainer>
                  <ComposedChart data={pingRows}>
                    <CartesianGrid strokeDasharray="2 4" className="stroke-border" vertical={false} />
                    <XAxis
                      {...timeAxis(pingRows, zoomed?.[0] ?? 0, zoomed?.[1] ?? pingRows.length - 1)}
                    />
                    {/* Not anchored at zero: these lines live in a narrow band
                        far from it, and zero flattens every wobble. */}
                    <YAxis unit="ms" width={52} domain={["auto", "auto"]} {...AXIS} />
                    <Tooltip
                      labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("zh-CN")}
                      // The line is drawn from what answered, so without this a
                      // bucket that lost most of its packets reads as normal.
                      // `dataKey` is `t7`/`s7`; the loss sits at `l7`.
                      formatter={(v, name, item) => {
                        const loss = Number(item?.payload?.[`l${String(item.dataKey).slice(1)}`] ?? 0)
                        return [`${Number(v).toFixed(1)} ms${loss > 0 ? ` · 丢 ${loss}%` : ""}`, name]
                      }}
                      contentStyle={TOOLTIP_STYLE}
                    />
                    {/* Behind the line, the range that bucket's answers
                        spanned -- Smokeping's "smoke". At the day window a
                        bucket moves 63 ms at the 90th percentile against the
                        25 ms the trend moves, so a line alone draws the smaller
                        of the two.

                        Only with one probe on screen: rendered for four, the
                        bands overlap into a fog and their extremes drag the
                        axis from 165-385 out to 140-420. */}
                    {shownProbes.length === 1 &&
                      shownProbes.map((s) => (
                        <Area
                          key={`band${s.id}`}
                          dataKey={`b${s.id}`}
                          stroke="none"
                          fill={style(s.id).stroke}
                          fillOpacity={0.16}
                          isAnimationActive={false}
                          tooltipType="none"
                          legendType="none"
                          connectNulls
                        />
                      ))}
                    {shownProbes.map((s) => (
                      <Line
                        key={s.id}
                        dataKey={`${smooth ? "s" : "t"}${s.id}`}
                        name={s.name}
                        stroke={style(s.id).stroke}
                        strokeDasharray={style(s.id).dash}
                        {...SERIES}
                        connectNulls
                      />
                    ))}
                    {/* Drag either handle to zoom into a stretch of the trend. */}
                    <Brush
                      ariaLabel="调整延迟图表时间范围"
                      dataKey="ts"
                      height={22}
                      travellerWidth={8}
                      tickFormatter={clockFor(hours)}
                      fill="var(--popover)"
                      stroke="var(--primary)"
                      // Controlled: left to itself the brush snaps back to the
                      // full range whenever the rows change.
                      startIndex={zoomed?.[0] ?? 0}
                      endIndex={zoomed?.[1] ?? pingRows.length - 1}
                      onChange={(r) => {
                        const last = pingRows.length - 1
                        const from = r.startIndex ?? 0
                        const to = r.endIndex ?? last
                        if (from <= 0 && to >= last) return setZoom(null)
                        setZoom([pingRows[from].ts, to >= last ? Infinity : pingRows[to].ts])
                      }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Under the chart: what it covers is picked at the top, what is
                drawn in it is picked here. Recharts paints the brush into the
                same SVG as the axis, so this is as close beneath as HTML
                sits. */}
            {(pingSeries.length > 1 || pingSeries.some((s) => s.loss > 0)) && (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {pingSeries.map((s) => {
                const shown = !hiddenProbes.includes(s.id)
                return (
                  <button
                    key={s.id}
                    aria-pressed={shown}
                    onClick={() =>
                      setHiddenProbes((h) => (shown ? [...h, s.id] : h.filter((id) => id !== s.id)))
                    }
                    className={`inline-flex min-w-0 max-w-full items-center gap-1.5 border px-2 py-1 text-xs transition-opacity ${
                      shown ? "" : "opacity-40"
                    }`}
                  >
                    {/* The swatch carries the same shade and dash as the line. */}
                    <svg width="14" height="6" className="shrink-0" aria-hidden>
                      <line
                        x1="0"
                        y1="3"
                        x2="14"
                        y2="3"
                        stroke={style(s.id).stroke}
                        strokeDasharray={style(s.id).dash}
                        strokeWidth="2"
                      />
                    </svg>
                    {s.name}
                    {/* The line is only what answered, so a probe dropping
                        half its packets draws like a healthy one. */}
                    {s.loss > 0 && (
                      <span className="tabular-nums opacity-60">
                        丢 {s.loss < 1 ? "<1" : Math.round(s.loss)}%
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            )}
          </div>
        )
      ) : <div className="resource-panels">{resourcePlots(node).filter(plot=>tab!=="traffic" || plot.title==="上传 / 下载").map(plot=><div key={plot.title} className="resource-panel"><Panel title={<span className="flex items-center justify-between gap-2"><span className="flex items-baseline gap-2">{plot.title}{"usage" in plot && <span className="usage-number" data-tone={usageTone(plot.usage)}>{plot.usage==null?"—":`${plot.usage.toFixed(0)}%`}</span>}</span><span className="text-xs text-muted-foreground">{ADMIN_RANGES.find(r=>r.hours===hours)?.label}</span></span>}>
        {metricRows.length===0 ? <p className="py-8 text-center text-sm">这段时间没有历史数据</p> : <ResponsiveContainer><LineChart data={metricRows}><CartesianGrid strokeDasharray="2 4" className="stroke-border" vertical={false}/><XAxis {...timeAxis(metricRows)}/><YAxis domain={[plot.domain[0] as number, plot.domain[1] as number | "auto"]} tickFormatter={plot.bytes?axisBytes:undefined} width={Y_WIDTH} {...AXIS}/><Tooltip labelFormatter={ts=>new Date(Number(ts)).toLocaleString("zh-CN")} formatter={v=>plot.bytes?bytes(Number(v)):String(v)} contentStyle={TOOLTIP_STYLE}/>{plot.series.map((series,i)=>series.disabled ? null : <Line key={series.key} dataKey={series.key} name={series.label} stroke={PALETTE[i].stroke} strokeDasharray={PALETTE[i].dash} connectNulls={false} {...SERIES}/>)}</LineChart></ResponsiveContainer>}
      </Panel><ul className="chart-series">{plot.series.map((series,i)=><li key={series.key}><span style={{borderTopColor:PALETTE[i].stroke,borderTopStyle:i===1?"dashed":i===2?"dotted":"solid"}} aria-hidden="true"/>{series.label}<b>{series.current==null?"未上报":series.disabled?"未启用":plot.bytes?`${bytes(series.current)}${plot.title==="上传 / 下载"?"/s":""}`:`${series.current}${plot.title==="CPU"?"%":""}`}</b></li>)}</ul>
      {plot.title==="RAM"&&<p className="px-4 pb-4 text-xs text-muted-foreground">Swapfile {m?.swapfile_used==null?"未上报":bytes(m.swapfile_used)} · 分区 {m?.swap_partition_used==null?"未上报":bytes(m.swap_partition_used)}</p>}
      </div>)}</div>}
      </div>
    </div>
  )
}

function bandwidth(value?:number){return !value?"未设置":value>=1000?`${value/1000} Gbps`:`${value} Mbps`}
function resourcePlots(node:Node){
  const m=node.online?node.metrics:null
  const series=(key:string,label:string,current:number|null|undefined,disabled=false)=>({key,label,current,disabled})
  return [
    {title:"CPU",usage:m?.cpu,bytes:false,domain:[0,100],series:[series("cpu","CPU",m?.cpu)]},
    {title:"RAM",usage:m && m.mem_total>0?percent(m.mem_used,m.mem_total):null,bytes:true,domain:[0,Math.max(node.mem_total,m?.swap_disk_total??0,1)],series:[series("mem_used","RAM",m?.mem_used),series("zram_used","ZRAM",m?.zram_used,m?.zram_devices===0),series("swap_disk_used","Swap",m?.swap_disk_used,m?.swap_disk_total===0)]},
    {title:"磁盘",usage:m && m.disk_total>0?percent(m.disk_used,m.disk_total):null,bytes:true,domain:[0,Math.max(node.disk_total,1)],series:[series("disk_used","磁盘用量",m?.disk_used)]},
    {title:"进程数",bytes:false,domain:[0,"auto"],series:[series("procs","进程",m?.procs)]},
    {title:"上传 / 下载",bytes:true,domain:[0,"auto"],series:[series("net_tx","上传",m?.net_tx),series("net_rx","下载",m?.net_rx)]},
    {title:"TCP / UDP 连接",bytes:false,domain:[0,"auto"],series:[series("tcp","TCP",m?.tcp),series("udp","UDP",m?.udp)]},
  ]
}
