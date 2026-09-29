import type { Node } from "@/lib/api"
import { bytes, rate } from "@/lib/format"

export function Summary({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter(n => n.online)
  const sum = (key: "total_tx" | "total_rx") => nodes.reduce((total, n) => total + n[key], 0)
  const speed = (key: "net_tx" | "net_rx") => online.reduce((total, n) => total + (n.metrics?.[key] ?? 0), 0)
  return <dl className="fleet-summary summary-kpis">
    <div><dt>服务器总数</dt><dd>{nodes.length}</dd></div>
    <div><dt>在线服务器</dt><dd className="text-ok">{online.length}</dd></div>
    <div><dt>离线服务器</dt><dd className="text-destructive">{nodes.length-online.length}</dd></div>
    <div className="network-kpi"><dt>网络</dt><dd><table className="card-network" aria-label="网络汇总"><thead><tr><th></th><th>上传</th><th>下载</th></tr></thead><tbody>
      <tr><th>实时速率</th><td>{rate(speed("net_tx"))}</td><td>{rate(speed("net_rx"))}</td></tr>
      <tr><th>累计流量</th><td>{bytes(sum("total_tx"))}</td><td>{bytes(sum("total_rx"))}</td></tr>
    </tbody></table></dd></div>
  </dl>
}
