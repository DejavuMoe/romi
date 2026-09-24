import { connectionLabel } from "../../../shared/nodes"
import { Badge } from "./ui/badge"
import { Meter } from "./Meter"
import type { Node } from "../lib/api"
import { continuousUptime, monthUsage, bytes, daysUntil, FOREVER, osName, pair, percent, rate, uptime, CYCLES } from "../lib/format"
import { cn } from "../lib/utils"

export function Status({ node }: { node: Node }) {
  return <span className={cn("node-status", node.online ? "text-ok" : "text-muted-foreground")}><span aria-hidden="true">{node.online ? "▪" : "▫"}</span> {connectionLabel(node)}</span>
}

/** Where the machine is, in the same shape as the badge next to it. */
export function Country({ node }: { node: Node }) {
  if (!node.country) return null
  return (
    <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
      {node.country}
    </Badge>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `已用 ${bytes(monthUsage(node))}`
}

// No date means nothing expires: a permanent host, or one with no renewal set. A
// blank corner asserts neither.
function Expiry({ node }: { node: Node }) {
  const days = daysUntil(node.expires_at)
  if (days === null) return <span className="text-xs text-muted-foreground" aria-label="永不到期">{FOREVER}</span>
  const tone = days < 0 ? "text-destructive" : days <= 7 ? "text-warn" : "text-muted-foreground"
  return (
    <span className={cn("tnum text-xs", tone)}>
      {days < 0 ? `已过期 ${-days} 天` : `${days} 天后到期`}
    </span>
  )
}

export function NodeCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.online ? node.metrics : null
  return (
    // No aria-label: one on the card replaces everything inside it, so a screen
    // reader hears "查看 <名称>" and never the status, billing or resources the
    // card exists to show. The list view already names its link from its own
    // text.
    <a href={`/node/${node.id}`} className="public-node-card" onClick={(event) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen() }
    }}>
      <div className="card-identity"><h3>{node.name}</h3><Status node={node} /></div>
      <div className="card-billing"><span>{node.price > 0 ? `${node.currency} ${node.price.toFixed(2)} / ${CYCLES[node.billing_cycle] ?? node.billing_cycle}` : "免费"}</span><Expiry node={node} /></div>
      <div className="card-system">
        <div className="card-system-line"><span>{node.os ? osName(node.os) : "等待首次上报"}</span><span>内核 {node.kernel || "—"}</span></div>
        <span>{node.cpu_name || "CPU 待上报"}{node.cpu_cores ? ` · ${node.cpu_cores} vCPU` : ""}{node.arch ? ` · ${node.arch}` : ""}</span>
      </div>
      <div className="card-resources">
        <Meter label="CPU" pct={m?.cpu ?? null} foot={node.cpu_cores ? `${node.cpu_cores} vCPU` : "待上报"} />
        <Meter label="RAM" pct={m && m.mem_total>0 ? percent(m.mem_used, m.mem_total) : null} foot={node.mem_total ? m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total) : "待上报"} />
        <Meter label="磁盘" pct={m && m.disk_total>0 ? percent(m.disk_used, m.disk_total) : null} foot={node.disk_total ? m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total) : "待上报"} />
      </div>
      <table className="card-network"><thead><tr><th>网络</th><th>上传</th><th>下载</th></tr></thead><tbody>
        <tr><th>可用带宽</th><td>{bandwidth(node.bandwidth_up)}</td><td>{bandwidth(node.bandwidth_down)}</td></tr>
        <tr><th>实时速率</th><td>{m ? rate(m.net_tx) : "—"}</td><td>{m ? rate(m.net_rx) : "—"}</td></tr>
        <tr><th>累计流量</th><td>{bytes(node.total_tx)}</td><td>{bytes(node.total_rx)}</td></tr>
      </tbody></table>
      <div className="card-period"><span>本期流量</span><span>{trafficFoot(node)}</span></div>
      <div className="card-foot"><span>连续在线 {continuousUptime(node)}</span><span>本次启动 {m ? uptime(m.uptime) : "—"}</span>{!node.online && node.last_seen > 0 && <span>已离线 {uptime(Math.max(0, Date.now() / 1000 - node.last_seen))}</span>}</div>
    </a>
  )
}

function bandwidth(value?:number){return !value?"未设置":value>=1000?`${value/1000} Gbps`:`${value} Mbps`}
