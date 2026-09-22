import type { Node } from "../lib/api"
import { bytes, monthUsage, percent, rate, osName } from "../lib/format"
import { usageTone } from "../../../shared/usage"
import { Status } from "./NodeCard"

function Resource({ label, value }: { label: string; value: number | null }) {
  return <><span className="list-label">{label}</span><div className="list-meter" data-tone={usageTone(value)}><span className="usage-number">{value === null ? "—" : `${Math.round(value)}%`}</span><div className="list-track" aria-hidden="true"><i className="usage-fill" style={{width:`${value === null ? 0 : Math.max(0, Math.min(100, value))}%`}} /></div></div></>
}

export function NodeList({ nodes, onOpen }: { nodes: Node[]; onOpen: (id: number) => void }) {
  return <table className="public-node-list" aria-label="公开节点列表"><thead><tr><th>节点 / 系统</th><th>状态</th><th>CPU</th><th>RAM</th><th>磁盘</th><th>上传 / 下载</th><th>本期 / 额度</th></tr></thead><tbody>
    {nodes.map(n => {
      const m = n.online ? n.metrics : null
      return <tr key={n.id}>
        <td className="public-list-name"><a href={`/node/${n.id}`} onClick={e => { if(e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onOpen(n.id) } }}>{n.name}</a><div className="node-meta">{n.os ? osName(n.os) : "等待首次上报"}{n.arch && ` · ${n.arch}`}</div></td>
        <td className="public-list-status"><Status node={n}/></td>
        <td><Resource label="CPU" value={m?.cpu ?? null}/></td>
        <td><Resource label="RAM" value={m && m.mem_total > 0 ? percent(m.mem_used,m.mem_total) : null}/></td>
        <td><Resource label="磁盘" value={m && m.disk_total > 0 ? percent(m.disk_used,m.disk_total) : null}/></td>
        <td className="public-list-rate"><span className="list-label">上传 / 下载</span><span>{m ? `${rate(m.net_tx)} / ${rate(m.net_rx)}` : "—"}</span></td>
        <td className="public-list-traffic"><span className="list-label">本期 / 额度</span><span>{bytes(monthUsage(n))} / {n.traffic_limit > 0 ? bytes(n.traffic_limit) : "不限"}</span></td>
      </tr>
    })}
  </tbody></table>
}
