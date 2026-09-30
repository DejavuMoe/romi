import { useRef, useState, type CSSProperties } from "react"
import { T } from "../../../../shared/i18n.ts"
import { CONNECTION, connection } from "../../../../shared/nodes.ts"
import { nodeFacts } from "../../../../web/src/components/Fleet"
import { expiry, monthUsage, uptime, tone, clock } from "../../../../web/src/lib/format"
import { useWidth } from "../../../../web/src/lib/hooks"
import { Button, Segmented } from "../../../../web/src/components/ui/controls"
import { CopyValue, Empty, Notice } from "../../../../web/src/components/ui/feedback"
import { Icon, type IconName } from "../../../../web/src/components/ui/icon"
import { FlowValue, Meter, Region, StatusDot } from "../../../../web/src/components/ui/status"
import { type Node } from "@/lib/api"
import { type Settings } from "./common"

function attention(nodes: Node[], settings: Settings | null) {
  const out: { node: Node; reasons: { tone: "bad" | "warn" | "info"; icon: IconName; text: string }[]; rank: number; order: number }[] = []
  nodes.forEach((node, order) => {
    const f = nodeFacts(node)
    const reasons: (typeof out)[number]["reasons"] = []
    if (f.status === "offline") reasons.push({ tone: "bad", icon: "wifi-off", text: T("离线 {time}", { time: uptime(Math.max(60, Date.now() / 1000 - node.last_seen)) }) })
    if (f.status === "reconnecting") reasons.push({ tone: "warn", icon: "loader-circle", text: T("重连中") })
    if (f.status === "never") reasons.push({ tone: "info", icon: "clock", text: T("尚未接入") })
    for (const [label, icon, value] of [["CPU", "cpu", f.cpu], [T("内存"), "memory-stick", f.mem], [T("磁盘"), "hard-drive", f.disk]] as const) {
      if (value != null && value >= 85) reasons.push({ tone: "bad", icon, text: label + " " + value.toFixed(0) + "%" })
    }
    const exp = expiry(node)
    const expireAt = Number(settings?.notify_expiry) || 0
    if (exp.days != null && exp.days < 0) reasons.push({ tone: "bad", icon: "calendar", text: exp.text })
    else if (exp.days != null && expireAt && exp.days <= expireAt) reasons.push({ tone: "warn", icon: "calendar", text: exp.text })
    const trafficAt = Number(settings?.notify_traffic) || 0
    const pct = node.traffic_limit > 0 ? monthUsage(node) / node.traffic_limit * 100 : 0
    if (trafficAt && pct >= 100) reasons.push({ tone: "bad", icon: "arrow-down-up", text: T("本期流量已用尽") })
    else if (trafficAt && pct >= trafficAt) reasons.push({ tone: "warn", icon: "arrow-down-up", text: T("本期流量 {pct}%", { pct: pct.toFixed(0) }) })
    if (reasons.length) out.push({ node, reasons, order, rank: reasons.some(r => r.tone === "bad") ? 0 : reasons.some(r => r.tone === "warn") ? 1 : 2 })
  })
  return out.sort((a, b) => a.rank - b.rank || a.order - b.order)
}

function AttentionBand({ items, onInspect }: { items: ReturnType<typeof attention>; onInspect: (node: Node) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const width = useWidth(list)
  if (!items.length) return <div className="attention attention-clear"><Icon name="circle-check" size={16} /><span>{T("所有节点运行正常")}</span></div>
  const fit = Math.max(1, Math.floor((width + 10) / 210))
  const cols = Math.ceil(items.length / Math.ceil(items.length / fit))
  return <section className="attention" aria-labelledby="attention-title">
    <div className="attention-head"><h2 id="attention-title">{T("需要关注")}</h2><span className="fleet-count num">{items.length}</span></div>
    <div ref={list} className="attention-list" style={{ "--cols": cols } as CSSProperties}>
      {items.map(({ node, reasons }) => <button type="button" key={node.id} className="attention-card" data-tone={reasons[0].tone} onClick={() => onInspect(node)}>
        <span className="attention-name"><StatusDot status={connection(node)} /><span>{node.name}</span></span>
        <span className="attention-reasons">{reasons.map((reason, i) => <span className="tag" key={i} data-tone={reason.tone === "info" ? undefined : reason.tone}><Icon name={reason.icon} size={12} />{reason.text}</span>)}</span>
      </button>)}
    </div>
  </section>
}

function LoadCell({ node }: { node: Node }) {
  const f = nodeFacts(node)
  return <span className="load-cell">
    {([["CPU", f.cpu], [T("内存"), f.mem], [T("磁盘"), f.disk]] as const).map(([label, value]) =>
      <span className="load-row" data-tone={tone(value)} key={label}><span className="load-label">{label}</span><Meter value={value} thin /><b className="num">{value == null ? "—" : Math.round(value) + "%"}</b></span>)}
  </span>
}

export function Nodes({ nodes, beat, updated, connected, settings, settingsError, onRetrySettings, onInspect, onOpen, onAdd, onRegister, canProvision, distributionAvailable }: {
  nodes: Node[]; beat: number; updated: number; connected: boolean; settings: Settings | null; settingsError: string
  onRetrySettings: () => void; onInspect: (node: Node) => void; onOpen: (node: Node) => void
  onAdd: () => void; onRegister: () => void; site: string; canProvision: boolean; distributionAvailable: boolean
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<"all" | "online" | "offline">("all")
  const needle = query.trim().toLowerCase()
  const visible = nodes.filter(node => [node.name, String(node.id), "node-" + node.id, node.ipv4, node.ipv6, node.remark].some(value => String(value || "").toLowerCase().includes(needle)) &&
    (filter === "all" || node.online === (filter === "online")))
  const online = nodes.filter(node => node.online).length
  const add = <Button kind="primary" icon="plus" disabled={!canProvision} onClick={onAdd}>{T("添加节点")}</Button>
  const register = <Button icon="ticket" disabled={!canProvision || !distributionAvailable} onClick={onRegister}>{T("批量注册")}</Button>
  return <div className="stack-page">
    {settingsError && <Notice tone="warn" action={<Button size="sm" onClick={onRetrySettings}>{T("重试")}</Button>}>{T(settingsError)}</Notice>}
    {!!nodes.length && <AttentionBand items={attention(nodes, settings)} onInspect={onInspect} />}
    {!!nodes.length && <div className="toolbar">
      <label className="search-field search-wide"><Icon name="search" /><input type="search" aria-label={T("搜索节点")} placeholder={T("搜索名称、IP 或节点标识")} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <Segmented label={T("节点状态筛选")} value={filter} onChange={setFilter} options={[
        { value: "all", label: T("全部"), count: nodes.length }, { value: "online", label: T("在线"), count: online }, { value: "offline", label: T("离线"), count: nodes.length - online },
      ]} />
      <div className="toolbar-end"><span className="toolbar-meta" data-live={connected}><span className="live-dot" />
        {needle && <span className="num">{T("{n} 个匹配", { n: visible.length })}</span>}
        <span className="num">{T("更新于 {time}", { time: clock(updated) })}</span></span>{register}{add}</div>
    </div>}
    {!canProvision && <Notice tone="warn" icon="lock">{T("请通过 HTTPS 域名访问面板后添加或安装节点。")}</Notice>}
    {canProvision && !distributionAvailable && <Notice tone="warn">{T("Hub 尚未配置经过验证的 Agent 本地分发；请先用原生安装器安装当前 romi 发行版，再复制安装命令。")}</Notice>}
    {!connected && <Notice tone="warn" icon="wifi-off">{T("实时连接已断开，正在重连。列表停留在最后一次更新。")}</Notice>}
    {!nodes.length ? <><Empty icon="server" title={T("还没有节点")} detail={T("添加一个节点并在主机上安装 Agent，或开启注册窗口批量接入。")} /><div className="quick-actions">{add}{register}</div></> :
      !visible.length ? <Empty icon="search" title={T("没有匹配的节点")} action={T("清除搜索")} onAction={() => { setQuery(""); setFilter("all") }} /> :
      <div className="table-card"><table className="admin-table" aria-label={T("节点列表")}>
        <thead><tr>{[T("节点"), T("地址"), T("负载"), T("网络"), T("Agent 版本"), T("接入标识"), T("优先级")].map(label => <th scope="col" key={label}>{label}</th>)}<th scope="col"><span className="sr-only">{T("操作")}</span></th></tr></thead>
        <tbody>{visible.map(node => {
          const f = nodeFacts(node)
          return <tr key={node.id} data-status={f.status} onClick={e => { if (!(e.target as Element).closest("a,button")) onInspect(node) }}>
            <th scope="row" className="at-node"><span className="at-name"><StatusDot status={f.status} beat={beat} />
              <a href={"/admin/node/" + node.id} onClick={e => { e.preventDefault(); onOpen(node) }}>{node.name}</a></span>
              <span className="at-tags"><Region code={node.country} /><span className="status-text" data-status={f.status}>{T(CONNECTION[f.status])}</span>
                {!node.public && <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>}
                {!node.notify && <span className="tag"><Icon name="bell" size={12} />{T("通知关闭")}</span>}</span>
              {node.remark && <span className="at-remark">{node.remark}</span>}</th>
            <td className="at-addr">{(["ipv4", "ipv6"] as const).map((key, i) => <span className="addr-line" key={key}><span className="addr-kind">{i ? "IPv6" : "IPv4"}</span><CopyValue value={node[key] || (node.ip?.includes(":") === !!i ? node.ip : "")} label={node.name + (i ? " IPv6" : " IPv4")} /></span>)}</td>
            <td><LoadCell node={node} /></td>
            <td className="at-net num"><span className="at-net-rates"><FlowValue dir="down" value={f.m?.net_rx} /><FlowValue dir="up" value={f.m?.net_tx} /></span></td>
            <td className="mono">{node.agent_version || <span className="muted">{T("未上报")}</span>}</td>
            <td><CopyValue value={"node-" + node.id} label={T("{name} 接入标识", { name: node.name })} /></td>
            <td className="num num-col">{node.priority ?? 0}</td>
            <td className="at-actions"><Button size="sm" icon="sliders-horizontal" aria-label={T("管理 {name}", { name: node.name })} onClick={() => onInspect(node)}>{T("管理")}</Button></td>
          </tr>
        })}</tbody>
      </table></div>}
  </div>
}
