// The fleet: the globe band, the node cards and the list. The status page shows
// them for public nodes; the panel links into the same detail page.
import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react"

import { countryName, place } from "../../../shared/geo.ts"
import { T } from "../../../shared/i18n.ts"
import { CONNECTION, connection, type Connection } from "../../../shared/nodes.ts"
import { spark, type Node } from "../lib/api"
import { bytes, bytesParts, clock, continuousUptime, expiry, monthUsage, osName, pair, percent, price, rateParts, tone, uptime } from "../lib/format"
import { cx, useNow } from "../lib/hooks"
import { QuotaBar, Sparkline } from "./charts"
import { FleetGlobe } from "./Globe"
import { Segmented } from "./ui/controls"
import { Empty, Notice } from "./ui/feedback"
import { Icon } from "./ui/icon"
import { AnimatedNumber, DirValue, FlowValue, LocalSky, Meter, Region, StatusBadge, StatusDot } from "./ui/status"

export function nodeFacts(node: Node) {
  const m = node.online ? node.metrics : null
  const mem = m && m.mem_total > 0 ? percent(m.mem_used, m.mem_total) : null
  const disk = m && m.disk_total > 0 ? percent(m.disk_used, m.disk_total) : null
  const cpu = m ? m.cpu : null
  const worst = m ? Math.max(m.cpu, mem ?? 0, disk ?? 0) : null
  return { m, mem, disk, cpu, worst, status: connection(node), tone: tone(worst) }
}

export function systemLine(node: Node) {
  if (!node.os) return T("等待首次上报")
  return [osName(node.os), node.arch, node.cpu_cores ? `${node.cpu_cores} vCPU` : ""].filter(Boolean).join(" · ")
}

export function outage(node: Node): { tone: "bad" | "warn"; text: string } | null {
  const status = connection(node)
  const gap = Math.max(0, Date.now() / 1000 - node.last_seen)
  if (status === "offline") return { tone: "bad", text: T("已离线 {time}", { time: gap < 60 ? T("{m} 分", { m: 1 }) : uptime(gap) }) }
  if (status === "reconnecting") return { tone: "warn", text: T("中断 {n} 分钟 · 在线时段暂保留", { n: Math.max(1, Math.round(gap / 60)) }) }
  return null
}

/** A plain click opens the page in place; a modified one is left to the browser. */
export function openNode(e: MouseEvent, node: Node, onOpen: (node: Node) => void) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  onOpen(node)
}

// A resource line: name, used of total, the percentage and its bar -- or, for
// CPU, the last three minutes in the bar's place.
export function MeterRow({ label, pct, detail, trend }: { label: ReactNode; pct: number | null; detail: ReactNode; trend?: ReactNode }) {
  return (
    <div className={cx("meter-row", trend && "has-trend")} data-tone={tone(pct)}>
      <span className="meter-row-label">{label}</span>
      <span className="meter-row-detail num">{detail}</span>
      <span className="meter-row-pct num">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
      {trend}
      <Meter value={pct} />
    </div>
  )
}

// The rate now, its share of the configured link where one is set, and the total.
function RateCell({ dir, value, bandwidth, total }: { dir: "down" | "up"; value: number | null; bandwidth?: number; total: number }) {
  const mbps = value != null ? (value * 8) / 1e6 : null
  const share = mbps != null && bandwidth ? Math.min(100, (mbps / bandwidth) * 100) : null
  const parts = value != null ? rateParts(value) : null
  return (
    <div className="rate" data-dir={dir}>
      <DirValue dir={dir} value={parts ? Number(parts.value) : null} unit={parts?.unit} digits={parts?.value.includes(".") ? 1 : 0} />
      {!!bandwidth && <span className="rate-bar" aria-hidden="true"><i style={{ width: `${share ?? 0}%` }}></i></span>}
      <span className="rate-sub num">{T("累计 {size}", { size: bytes(total) })}</span>
    </div>
  )
}

export function NodeCard({ node, beat, onOpen, index = 0, href }: { node: Node; beat?: number; onOpen: (node: Node) => void; index?: number; href?: string }) {
  const f = nodeFacts(node)
  const down = outage(node)
  const exp = expiry(node)
  const pending = T("待上报")
  return (
    <article className="node-card" data-status={f.status} data-tone={f.tone} style={{ "--i": index, viewTransitionName: `node-${node.id}` } as CSSProperties}>
      <header className="nc-head">
        <div className="nc-title">
          <h3>
            <Region code={node.country} />
            <a className="nc-link" href={href || `/node/${node.id}`} onClick={(e) => openNode(e, node, onOpen)}>{node.name}</a>
            <LocalSky code={node.country} />
          </h3>
          <p className="nc-meta">{systemLine(node)}</p>
        </div>
        <StatusBadge node={node} beat={beat} />
      </header>
      {down && (
        <p className="nc-alert" data-tone={down.tone}>
          <Icon name={down.tone === "bad" ? "wifi-off" : "loader-circle"} size={14} className={down.tone === "warn" ? "spin" : ""} />
          <span>{down.text}</span>
        </p>
      )}
      <div className="nc-meters">
        <MeterRow
          label="CPU"
          pct={f.cpu}
          detail={f.m ? T("负载 {load}", { load: f.m.load[0].toFixed(2) }) : node.cpu_cores ? `${node.cpu_cores} vCPU` : pending}
          trend={<Sparkline points={spark(node.id)} get={(p) => p.cpu} max={100} beat={beat} height={28} color="var(--trend)" />}
        />
        <MeterRow label={T("内存")} pct={f.mem} detail={f.m ? pair(f.m.mem_used, f.m.mem_total) : node.mem_total ? bytes(node.mem_total) : pending} />
        <MeterRow label={T("磁盘")} pct={f.disk} detail={f.m ? pair(f.m.disk_used, f.m.disk_total) : node.disk_total ? bytes(node.disk_total) : pending} />
      </div>
      <div className="nc-net">
        <RateCell dir="down" value={f.m ? f.m.net_rx : null} bandwidth={node.bandwidth_down} total={node.total_rx} />
        <RateCell dir="up" value={f.m ? f.m.net_tx : null} bandwidth={node.bandwidth_up} total={node.total_tx} />
      </div>
      <QuotaBar node={node} />
      <footer className="nc-foot">
        <span className="nc-price">{price(node)}</span>
        <span className={`ink-${exp.tone}`}>{exp.text}</span>
        <span>{T("连续在线")} <b>{continuousUptime(node)}</b></span>
        <span className="nc-boot">{T("本次启动")} <b>{f.m ? uptime(f.m.uptime) : "—"}</b></span>
      </footer>
    </article>
  )
}

export function NodeRows({ nodes, beat, onOpen, labelledBy }: { nodes: Node[]; beat?: number; onOpen: (node: Node) => void; labelledBy?: string }) {
  return (
    <div className="node-list-wrap">
      <table className="node-list" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">{T("节点")}</th>
            <th scope="col">CPU</th>
            <th scope="col">{T("内存")}</th>
            <th scope="col">{T("磁盘")}</th>
            <th scope="col">{T("网络")}</th>
            <th scope="col">{T("本期流量")}</th>
            <th scope="col">{T("连续在线")}</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const f = nodeFacts(node)
            const used = monthUsage(node)
            const quota = node.traffic_limit > 0 ? (used / node.traffic_limit) * 100 : null
            return (
              <tr key={node.id} data-status={f.status} data-tone={f.tone}>
                <th scope="row" className="nl-node">
                  <span className="nl-name">
                    <Region code={node.country} />
                    <a href={`/node/${node.id}`} onClick={(e) => openNode(e, node, onOpen)}>{node.name}</a>
                  </span>
                  <span className="nl-sub">
                    <StatusBadge node={node} beat={beat} compact />
                    <span className="nl-meta">{systemLine(node)}</span>
                  </span>
                </th>
                <td className="nl-cpu">
                  <span className="nl-label">CPU</span>
                  <span className="nl-cpu-cell">
                    <Sparkline points={spark(node.id).slice(-40)} get={(p) => p.cpu} max={100} beat={beat} height={24} color="var(--trend)" />
                    <b className={cx("num", f.cpu != null && `tone-${tone(f.cpu)}`)}>{f.cpu == null ? "—" : `${f.cpu.toFixed(0)}%`}</b>
                  </span>
                </td>
                <td className="nl-meter">
                  <span className="nl-label">{T("内存")}</span>
                  <span className="nl-meter-cell"><b className={cx("num", f.mem != null && `tone-${tone(f.mem)}`)}>{f.mem == null ? "—" : `${Math.round(f.mem)}%`}</b><Meter value={f.mem} thin /></span>
                </td>
                <td className="nl-meter">
                  <span className="nl-label">{T("磁盘")}</span>
                  <span className="nl-meter-cell"><b className={cx("num", f.disk != null && `tone-${tone(f.disk)}`)}>{f.disk == null ? "—" : `${Math.round(f.disk)}%`}</b><Meter value={f.disk} thin /></span>
                </td>
                <td className="nl-net">
                  <span className="nl-label">{T("网络")}</span>
                  <span className="nl-net-cell">
                    <FlowValue dir="down" value={f.m ? f.m.net_rx : null} />
                    <FlowValue dir="up" value={f.m ? f.m.net_tx : null} />
                  </span>
                </td>
                <td className="nl-quota">
                  <span className="nl-label">{T("本期流量")}</span>
                  <span className="nl-meter-cell">
                    <b className="num">{node.traffic_limit > 0 ? pair(used, node.traffic_limit) : T("{size} · 不限", { size: bytes(used) })}</b>
                    <Meter value={quota} thin tone={quota == null ? "unknown" : quota >= 100 ? "critical" : quota >= 80 ? "warning" : "neutral"} />
                  </span>
                </td>
                <td className="nl-uptime">
                  <span className="nl-label">{T("连续在线")}</span>
                  <span>{continuousUptime(node)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function CardSkeleton() {
  return (
    <div className="card-grid" role="status" aria-label={T("正在加载节点")}>
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton card-skeleton" style={{ "--i": i } as CSSProperties}></div>)}
    </div>
  )
}

// The whole fleet's download and upload over the last three minutes.
function FleetFlow({ nodes, beat }: { nodes: Node[]; beat?: number }) {
  const buffers = nodes.map((n) => spark(n.id))
  const len = buffers.length ? Math.min(...buffers.map((b) => b.length)) : 0
  if (!len) return null
  const total = (key: "rx" | "tx") => Array.from({ length: len }, (_, i) => {
    const present = buffers.map((b) => b[b.length - len + i][key]).filter((v): v is number => v != null)
    return { v: present.length ? present.reduce((t, v) => t + v, 0) : null }
  })
  const rx = total("rx"), tx = total("tx")
  const max = Math.max(1, ...rx.map((p) => p.v ?? 0), ...tx.map((p) => p.v ?? 0)) * 1.2
  return (
    <div className="flow" aria-hidden="true">
      <Sparkline points={rx} get={(p) => p.v} max={max} beat={beat} height={48} color="var(--flow-down)" className="flow-rx" fixed />
      <Sparkline points={tx} get={(p) => p.v} max={max} beat={beat} height={48} color="var(--flow-up)" className="flow-tx" fixed />
    </div>
  )
}

export function LiveBadge({ connected }: { connected: boolean }) {
  const now = useNow(1000)
  return (
    <span className="live" data-live={connected}>
      <span className="live-dot"></span>
      {connected ? (
        <>
          <span>{T("实时")}</span>
          <span className="live-clock num">{clock(now)}</span>
        </>
      ) : (
        <span>{T("连接中断，正在重连")}</span>
      )}
    </span>
  )
}

export const STATUS_ORDER: Connection[] = ["online", "reconnecting", "offline", "never"]

// The band above the fleet: how many are up, what is moving, and where.
function FleetHero({ nodes, beat, theme, onOpen, filter, setFilter, connected }: {
  nodes: Node[]
  beat?: number
  theme?: string
  onOpen: (node: Node) => void
  filter: Connection | null
  setFilter: (next: Connection | null) => void
  connected: boolean
}) {
  const counts: Record<Connection, number> = { online: 0, reconnecting: 0, offline: 0, never: 0 }
  nodes.forEach((n) => counts[connection(n)]++)
  const live = nodes.filter((n) => n.online && n.metrics)
  const sum = (k: "net_rx" | "net_tx") => live.reduce((t, n) => t + n.metrics![k], 0)
  const total = (k: "total_rx" | "total_tx") => nodes.reduce((t, n) => t + n[k], 0)
  const located = nodes.some((n) => place(n.country))
  const rate = (v: number) => {
    const p = rateParts(v)
    return { value: Number(p.value), unit: p.unit, digits: p.value.includes(".") ? 1 : 0 }
  }
  const rx = rate(sum("net_rx")), tx = rate(sum("net_tx"))
  const rxAll = bytesParts(total("total_rx")), txAll = bytesParts(total("total_tx"))
  return (
    <section className={cx("hero", !located && "hero-flat")} aria-labelledby="fleet-title">
      <div className="hero-summary">
        <div className="hero-top">
          <h1 id="fleet-title" className="hero-title">{T("节点状态")}</h1>
          <LiveBadge connected={connected} />
        </div>
        <p className="hero-count num">
          <span className="hero-count-big"><AnimatedNumber value={counts.online} /></span>
          <span className="hero-count-rest">{T("/ {total} 台在线", { total: nodes.length })}</span>
        </p>
        <div className="status-tiles" role="group" aria-label={T("按状态筛选")}>
          {STATUS_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className="status-tile"
              data-status={key}
              aria-pressed={filter === key}
              disabled={!counts[key] && filter !== key}
              onClick={() => setFilter(filter === key ? null : key)}
            >
              <span className="status-tile-label">
                <StatusDot status={key} />
                <span>{T(CONNECTION[key])}</span>
              </span>
              <b className="status-tile-count num">{counts[key]}</b>
            </button>
          ))}
        </div>
        <div className="hero-stats">
          <FleetFlow nodes={nodes} beat={beat} />
          <dl className="hero-stat-list">
            <div className="hero-stat">
              <dt>{T("实时速率")}</dt>
              <dd>
                <DirValue dir="down" value={rx.value} unit={rx.unit} digits={rx.digits} />
                <DirValue dir="up" value={tx.value} unit={tx.unit} digits={tx.digits} />
              </dd>
            </div>
            <div className="hero-stat">
              <dt>{T("累计流量")}</dt>
              <dd>
                <DirValue dir="down" value={rxAll.value} unit={rxAll.unit} />
                <DirValue dir="up" value={txAll.value} unit={txAll.unit} />
              </dd>
            </div>
          </dl>
        </div>
      </div>
      {located && <FleetGlobe nodes={nodes} beat={beat} theme={theme} connected={connected} onOpen={onOpen} />}
    </section>
  )
}

export type FleetState = "loading" | "error" | "ready"

export function FleetView({ nodes, beat, theme, onOpen, view, setView, state, onRetry, connected, emptyAction, error }: {
  nodes: Node[]
  beat?: number
  theme?: string
  onOpen: (node: Node) => void
  view: "cards" | "list"
  setView: (next: "cards" | "list") => void
  state: FleetState
  onRetry: () => void
  connected: boolean
  emptyAction?: ReactNode
  error?: string | null
}) {
  const [filter, setFilter] = useState<Connection | null>(null)
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const shown = nodes.filter((n) => (!filter || connection(n) === filter) && (!q || [n.name, n.country, countryName(n.country), n.os].some((v) => String(v || "").toLowerCase().includes(q))))
  const clear = () => {
    setFilter(null)
    setQuery("")
  }
  if (state === "error")
    return <Empty error title={T("暂时无法加载节点")} detail={error ? T(error) : T("请求失败，已保留上次的页面位置。")} action={T("重试")} onAction={onRetry} />
  return (
    <>
      {state === "loading" ? <div className="skeleton hero-skeleton" role="status" aria-label={T("正在加载")}></div> : nodes.length > 0 && (
        <FleetHero nodes={nodes} beat={beat} theme={theme} onOpen={onOpen} filter={filter} setFilter={setFilter} connected={connected} />
      )}
      <section className="fleet" aria-labelledby="fleet-list-title">
        <div className="fleet-bar">
          <div className="fleet-heading">
            <h2 id="fleet-list-title">{filter ? T("{status}节点", { status: T(CONNECTION[filter]) }) : T("全部节点")}</h2>
            <span className="count-badge num">{shown.length}</span>
            {(filter || q) && <button type="button" className="link-button" onClick={clear}>{T("清除筛选")}</button>}
          </div>
          <div className="fleet-tools">
            <label className="search-field">
              <Icon name="search" />
              <input type="search" aria-label={T("搜索节点")} placeholder={T("搜索名称、地区或系统")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <Segmented
              label={T("显示方式")}
              value={view}
              onChange={setView}
              options={[
                { value: "cards", label: T("卡片"), icon: "layout-grid" },
                { value: "list", label: T("列表"), icon: "list" },
              ]}
            />
          </div>
        </div>
        {!connected && <Notice tone="warn" icon="wifi-off">{T("实时连接已断开，正在重连。以下数据停留在最后一次更新。")}</Notice>}
        {state === "loading" ? (
          <CardSkeleton />
        ) : !nodes.length ? (
          emptyAction || <Empty icon="globe" title={T("还没有公开节点")} detail={T("管理员公开节点后会显示在这里。")} />
        ) : !shown.length ? (
          <Empty icon="search" compact title={T("没有匹配的节点")} action={T("清除筛选")} onAction={clear} />
        ) : view === "list" ? (
          <NodeRows nodes={shown} beat={beat} onOpen={onOpen} labelledBy="fleet-list-title" />
        ) : (
          <div className={cx("card-grid", !connected && "is-stale")}>
            {shown.map((n, i) => <NodeCard key={n.id} node={n} beat={beat} onOpen={onOpen} index={i} />)}
          </div>
        )}
      </section>
    </>
  )
}
