import { useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, type Node } from "@/lib/api"
import { connectionLabel } from "../../../../shared/nodes"

import { FOREVER, money, uptime } from "@/lib/format"

import { CopyValue, Addresses, ConfirmDialog } from "./common"
import { type IssuedNode, CreateNode, NodeForm, BillingForm, useRegisterWindow, RegisterDialog, InstallDialog } from "./node-forms"

export function Nodes({ nodes, refresh, site, canProvision, distributionAvailable, onOpen }: { onOpen:(id:number)=>void; nodes: Node[]; refresh: () => void; site: string; canProvision: boolean; distributionAvailable: boolean }) {
  const [creating, setCreating] = useState(false)
  const [managing, setManaging] = useState<Node | null>(null)
  const actionTrigger = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = (event: Event) => {
    event.preventDefault()
    if (document.querySelector('[role="dialog"]')) return
    const target = actionTrigger.current?.isConnected ? actionTrigger.current : document.getElementById("main")
    target?.focus()
  }
  const [editing, setEditing] = useState<Node | null>(null)
  const [billing, setBilling] = useState<Node | null>(null)
  const [installing, setInstalling] = useState<IssuedNode | null>(null)
  const [registering, setRegistering] = useState(false)
  const reg = useRegisterWindow()
  const [deleting, setDeleting] = useState<Node | null>(null)
  const [removing, setRemoving] = useState(false)
  const [query, setQuery] = useState("")
  const [filter,setFilter]=useState("all")
  const needle = query.trim().toLowerCase()
  const visible = nodes.filter(n => (!needle || [n.name, String(n.id), `node-${n.id}`, n.ip, n.ipv4, n.ipv6].some(v => v?.toLowerCase().includes(needle))) && (filter === "all" || n.online === (filter === "online")))

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/nodes/${deleting.id}`, { method: "DELETE" })
      toast.success("已删除")
      actionTrigger.current = null
      setDeleting(null)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="page-heading admin-node-heading"><h1>节点管理</h1><div className="admin-node-actions">
        <Button variant="outline" disabled={!canProvision || !distributionAvailable} onClick={() => setRegistering(true)}>批量注册{reg.left > 0 && ` · ${Math.ceil(reg.left / 60)} 分`}</Button>
        <Button disabled={!canProvision} onClick={event => { actionTrigger.current = event.currentTarget; setCreating(true) }}>添加节点</Button>
      </div>
      </div>
      {!canProvision && <p className="text-sm text-muted-foreground">请通过 HTTPS 域名访问面板后添加或安装节点。</p>}
      {canProvision && !distributionAvailable && <p className="text-sm text-muted-foreground">Hub 尚未配置经过验证的 Agent 本地分发；请先用原生安装器安装当前 romi 发行版，再复制安装命令。</p>}
      <div className="admin-node-toolbar"><Input placeholder="搜索名称、IP 或节点标识" aria-label="搜索节点" value={query} onChange={e => setQuery(e.target.value)} />
        <div className="view-switch" role="group" aria-label="节点状态筛选">{[["all","全部"],["online","在线"],["offline","离线"]].map(([key,label]) => <Button key={key} variant="ghost" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</Button>)}</div>
      </div>
      <table className="admin-node-table" aria-label="节点列表"><thead><tr><th>ID（优先级）</th><th>名称</th><th>IP</th><th>Agent 版本</th><th>接入标识</th><th>操作</th></tr></thead>
        <tbody>{visible.map(n => <tr key={n.id}>
          <td className="admin-id"><span className="admin-field-label">ID（优先级）</span><span className="admin-primary">{n.id} <span className="text-muted-foreground">({n.priority ?? 0})</span></span></td>
          <td className="admin-name"><a className="text-button" href={`/admin/node/${n.id}`} onClick={e => { if(e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); onOpen(n.id) } }}>{n.name}</a><span className={`node-status ${n.online ? "text-ok" : "text-muted-foreground"}`}>{n.online ? "▪" : "▫"} {connectionLabel(n)}</span>{!n.public && <span className="node-meta block">私有</span>}</td>
          <td className="admin-addresses"><div className="address-line"><span>IPv4</span><CopyValue value={n.ipv4 || (n.ip?.includes(":") ? undefined : n.ip)} label={`${n.name} IPv4`}/></div><div className="address-line"><span>IPv6</span><CopyValue value={n.ipv6 || (n.ip?.includes(":") ? n.ip : undefined)} label={`${n.name} IPv6`}/></div></td>
          <td className="admin-version"><span className="admin-field-label">Agent 版本</span><span className="admin-primary">{n.agent_version || "未上报"}</span></td>
          <td className="admin-identity"><span className="admin-field-label">接入标识</span><CopyValue value={`node-${n.id}`} label={`${n.name} 接入标识`}/></td>
          <td className="admin-menu"><Button variant="ghost" aria-label={`编辑菜单 ${n.name}`} onClick={event => { actionTrigger.current = event.currentTarget; setManaging(n) }}>编辑</Button></td>
        </tr>)}</tbody>
      </table>
      {!visible.length && <p className="py-8 text-sm text-muted-foreground">{nodes.length ? "没有匹配的节点" : "还没有节点，请先添加节点。"}</p>}
      {managing && <Dialog open onOpenChange={(open) => !open && setManaging(null)}>
        <DialogContent onCloseAutoFocus={restoreFocus}><DialogHeader><DialogTitle>{managing.name}</DialogTitle><DialogDescription>{managing.os || "尚未接入"}{managing.arch && ` · ${managing.arch}`}</DialogDescription></DialogHeader>
          <Addresses node={managing} />
          <p className="text-sm text-muted-foreground">{managing.price > 0 ? money(managing.price, managing.currency) : "免费"} · {managing.expires_at || FOREVER}</p>
          {!managing.online && managing.last_seen > 0 && <p className="text-sm text-muted-foreground">离线 {uptime(Date.now() / 1000 - managing.last_seen)}</p>}
          <div className="node-management-actions">
            <Button variant="outline" onClick={() => { setEditing(managing); setManaging(null) }}>编辑节点</Button>
            <Button variant="outline" onClick={() => { setBilling(managing); setManaging(null) }}>账单与流量</Button>
            <Button variant="outline" disabled={!canProvision || !distributionAvailable} onClick={() => { setInstalling(managing); setManaging(null) }}>安装 Agent</Button>

            <Button variant="destructive" onClick={() => { setDeleting(managing); setManaging(null) }}>删除节点</Button>
          </div>
        </DialogContent>
      </Dialog>}

      {creating && (
        <CreateNode onCloseAutoFocus={restoreFocus}
          onClose={() => setCreating(false)}
          onSaved={(fresh) => { refresh(); setInstalling(fresh) }}
        />
      )}
      {editing && (
        <NodeForm onCloseAutoFocus={restoreFocus}
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {billing && (
        <BillingForm onCloseAutoFocus={restoreFocus} node={billing} onClose={() => setBilling(null)} onSaved={refresh} />
      )}
      {registering && <RegisterDialog site={site} reg={reg} onClose={() => { setRegistering(false); refresh() }} />}

      {installing && (
        <InstallDialog onCloseAutoFocus={restoreFocus}
          node={installing}
          site={site}
          onClose={() => setInstalling(null)}
          onRotated={refresh}
        />
      )}
      {deleting && (
        <ConfirmDialog onCloseAutoFocus={restoreFocus}
          title={`删除节点「${deleting.name}」？`}
          description="历史指标、流量记录和凭证一并删除，不可恢复。"
          confirmLabel="删除节点"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}
