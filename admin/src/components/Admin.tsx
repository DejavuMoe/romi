import { useEffect, useId, useRef, useState } from "react"
import { ChevronRight, Copy, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { parseDate } from "@/lib/calendar"
import { DatePicker } from "@/components/ui/date-picker"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { addresses, agentCommand, api, ApiError, changes, GIB, registrationCommand, trafficCorrection, upload, type Node, type PingTask } from "@/lib/api"
import { connectionLabel } from "../../../shared/nodes"
import { bytes, CYCLES, FOREVER, money, uptime } from "@/lib/format"

// Counters the panel can correct after migration or an accounting error.
const TRAFFIC_FIELDS = [
  ["total_rx", "累计下行"],
  ["total_tx", "累计上行"],
  ["month_rx", "本月下行"],
  ["month_tx", "本月上行"],
] as const
const TRAFFIC_MODES: Record<string, string> = {
  sum: "上下行相加",
  max: "取较大值",
  up: "仅上行",
  down: "仅下行",
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("已复制"),
    () => toast.error("复制失败"),
  )
}

function CopyValue({ value, label }: { value?: string; label: string }) {
  return value ? <button type="button" className="copy-value" aria-label={`复制 ${label}`} onClick={() => copy(value)}><span>{value}</span><Copy className="copy-mark" aria-hidden="true" /></button> : <span className="text-muted-foreground">未上报</span>
}

function Addresses({ node }: { node: Node }) {
  return <div>{addresses(node).map(address => <CopyValue key={address} value={address} label={address} />)}</div>
}

type ReturnFocus = { onCloseAutoFocus?: (event: Event) => void }

function ConfirmDialog({ title, description, confirmLabel, busy = false, onClose, onConfirm, onCloseAutoFocus }: {
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
} & ReturnFocus) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t pt-4">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type IssuedNode = Pick<Node, "id" | "name"> & { token?: string }

function CreateNode({ onClose, onSaved, onCloseAutoFocus }: {
  onClose: () => void
  onSaved: (node: IssuedNode) => void
} & ReturnFocus) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return toast.error("请填写节点名称")
    setSaving(true)
    try {
      const fresh = await api<{ id: number; token: string }>("/nodes", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      })
      toast.success("节点已添加")
      onClose()
      onSaved({ ...fresh, name: name.trim() })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加节点</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={save}>
          <Field label="名称">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="香港 · 甲商家" />
          </Field>
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>添加</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function BandwidthField({label,value,onChange}:{label:string;value:number;onChange:(value:number)=>void}){
  const unitId=useId()
  const [unit,setUnit]=useState(value>=1000?"Gbps":"Mbps")
  const scale=unit==="Gbps"?1000:1
  const [typed,setTyped]=useState(String(value/scale))
  return <Field label={label} hint="0 表示未设置"><div className="flex gap-2"><Input type="number" min={0} max={1000000/scale} step="0.001" value={typed} onChange={e=>{const text=e.target.value;setTyped(text);onChange(/^\d+(?:\.\d+)?$/.test(text)?Number(text)*scale:NaN)}}/><Select value={unit} onValueChange={next=>{setUnit(next);if(Number.isFinite(value))setTyped(String(value/(next==="Gbps"?1000:1)))}}><SelectTrigger id={`${unitId}-unit`} aria-label={`${label}单位`}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="Mbps">Mbps</SelectItem><SelectItem value="Gbps">Gbps</SelectItem></SelectContent></Select></div></Field>
}

function NodeForm({ node, onClose, onSaved, onCloseAutoFocus }: {
  node: Node
  onClose: () => void
  onSaved: () => void
} & ReturnFocus) {
  const [form, setForm] = useState(node)
  const [unit, setUnit] = useState(node.traffic_unit || "GB")
  const [limitGib, setLimitGib] = useState(String(node.traffic_limit / GIB / (node.traffic_unit === "TB" ? 1024 : 1) || ""))
  const [formError, setFormError] = useState("")
  const [priority,setPriority]=useState(String(node.priority ?? 0))
  const [resetDay,setResetDay]=useState(String(node.traffic_reset_day))
  const [sameBandwidth,setSameBandwidth] = useState(node.bandwidth_up === node.bandwidth_down)
  const [saving, setSaving] = useState(false)
  const gib = (bytes: number) => String(Number((bytes / GIB).toFixed(3)))
  const [traffic, setTraffic] = useState(() =>
    Object.fromEntries(TRAFFIC_FIELDS.map(([k]) => [k, gib(node[k])])) as Record<string, string>,
  )
  // Compared as entered rather than as bytes: rounding to GB would read as an
  // edit and zero a node that has transferred a few MB.
  const pristine = useRef(traffic)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim()) return toast.error("请填写节点名称")
    const limit=Number(limitGib || "0") * (unit === "TB" ? 1024 : 1)
    if (!/^\d*(?:\.\d+)?$/.test(limitGib) || !Number.isFinite(limit) || limit<0) return setFormError("流量额度须为非负数，不支持指数写法")
    if (!/^\d+$/.test(resetDay) || Number(resetDay)<1 || Number(resetDay)>31) return setFormError("重置日须为 1–31 的整数")
    if (!/^\d+$/.test(priority) || Number(priority)>999999) return setFormError("展示优先级须为 0–999999 的整数")
    if ([form.bandwidth_down ?? 0,form.bandwidth_up ?? 0].some(v=>!Number.isFinite(v)||v<0||v>1000000)) return setFormError("可用带宽须为 0–1000000 Mbps")
    setFormError("")
    const patch = changes(node, {
      name: form.name.trim(),
      remark: form.remark,
      traffic_mode: form.traffic_mode,
      traffic_limit: Math.round(limit * GIB),
      traffic_unit: unit,
      priority: Number(priority),
      public: form.public ?? true,
      bandwidth_down: form.bandwidth_down ?? 0,
      bandwidth_up: sameBandwidth ? form.bandwidth_down ?? 0 : form.bandwidth_up ?? 0,
      has_ipv4: form.has_ipv4 ?? true,
      has_ipv6: form.has_ipv6 ?? false,
      traffic_reset_day: Number(resetDay),
      notify: !!form.notify,
    })
    const correction = trafficCorrection(pristine.current, traffic)
    if ([patch.traffic_limit, ...Object.values(correction)].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0))) {
      return toast.error("流量必须是有效的非负数，且不能超出精确计数范围")
    }
    setSaving(true)
    try {
      // The correction belongs to the new reset period, so its day is saved
      // first.
      if (Object.keys(patch).length) {
        await api(`/nodes/${node.id}`, { method: "PUT", body: JSON.stringify(patch) })
      }
      if (Object.keys(correction).length) {
        await api(`/nodes/${node.id}/traffic`, {
          method: "PUT",
          body: JSON.stringify(correction),
        })
      }
      toast.success("节点设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="名称">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每月流量额度" hint="0 表示不限">
              <div className="flex gap-2"><Input type="number" min={0} step="0.001" value={limitGib} onChange={(e) => setLimitGib(e.target.value)} placeholder="0" /><Select value={unit} onValueChange={v=>{setLimitGib(String(Number(limitGib || "0")*(v==="TB"?1/1024:1024)));setUnit(v)}}><SelectTrigger id={`traffic-unit-${node.id}`} aria-label="流量额度单位"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="GB">GB</SelectItem><SelectItem value="TB">TB</SelectItem></SelectContent></Select></div>
            </Field>
            <Field label="流量计算方式">
              <Select value={form.traffic_mode} onValueChange={(v) => set("traffic_mode", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TRAFFIC_MODES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每月重置日" hint="1–31。本月流量按新周期重算，总流量不变">
              <Input type="number" min={1} max={31} value={resetDay} onChange={(e) => setResetDay(e.target.value)} />
            </Field>
            <Field label="备注" hint="仅管理员可见">
              <Input value={form.remark ?? ""} onChange={(e) => set("remark", e.target.value)} placeholder="商家、用途" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="展示优先级" hint="0–999999 整数，数字越大越靠前"><Input type="number" min={0} max={999999} step={1} value={priority} onChange={e=>setPriority(e.target.value)}/></Field>
            <Field label="公开状态页" hint="私有节点只在管理列表显示。"><Select value={(form.public ?? true)?"public":"private"} onValueChange={v=>set("public",v==="public")}><SelectTrigger className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="public">显示</SelectItem><SelectItem value="private">不显示</SelectItem></SelectContent></Select></Field>
            {(["has_ipv4","has_ipv6"] as const).map((key,index)=><Field key={key} label={index ? "IPv6" : "IPv4"}><Select value={(form[key] ?? !index)?"yes":"no"} onValueChange={v=>set(key,v==="yes")}><SelectTrigger className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="yes">有</SelectItem><SelectItem value="no">无</SelectItem></SelectContent></Select></Field>)}
          </div>
          <fieldset className="border p-4 space-y-3"><legend className="px-1 text-sm">可用带宽</legend>
            <BandwidthField label="下载带宽" value={form.bandwidth_down ?? 0} onChange={v=>set("bandwidth_down",v)}/>
            <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={sameBandwidth} onChange={e=>{if(!e.target.checked)set("bandwidth_up",form.bandwidth_down??0);setSameBandwidth(e.target.checked)}}/>上传与下载相同</label>
            {!sameBandwidth && <BandwidthField label="上传带宽" value={form.bandwidth_up ?? 0} onChange={v=>set("bandwidth_up",v)}/>}
          </fieldset>
          <p role="alert" className="field-error">{formError}</p>
          <details className="group rounded-lg border bg-muted/30 px-3 py-2.5">
            <summary className="flex min-h-6 cursor-pointer items-center gap-2 text-sm font-medium"><ChevronRight className="size-4 transition-transform group-open:rotate-90" />流量校正</summary>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              按 GB 填入需要校正的值，未修改的计数器继续正常累计。
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {TRAFFIC_FIELDS.map(([key, label]) => (
                <Field key={key} label={`${label} (GB)`}>
                  <Input
                    type="number"
                    step="0.001"
                    value={traffic[key]}
                    onChange={(e) => setTraffic((t) => ({ ...t, [key]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </details>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">离线通知</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">掉线超过宽限期推送一条，恢复在线时再推一条</span>
            </span>
            <Switch checked={!!form.notify} onCheckedChange={(v) => set("notify", v)} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BillingForm({ node, onClose, onSaved, onCloseAutoFocus }: {
  node: Node
  onClose: () => void
  onSaved: () => void
} & ReturnFocus) {
  const [form, setForm] = useState(node)
  // Text rather than a number: a numeric state cannot represent an empty field,
  // so clearing it would snap back to 0 mid-entry. Empty means free.
  const [price, setPrice] = useState(node.price > 0 ? String(node.price) : "")
  const [error,setError]=useState("")
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    if(!/^\d*(?:\.\d{1,2})?$/.test(price) || !Number.isFinite(Number(price))) return setError("价格须为非负数，最多两位小数")
    if(form.expires_at && !parseDate(form.expires_at)) return setError("到期时间须为有效的 YYYY-MM-DD 日期")
    setError("")
    setSaving(true)
    try {
      await api(`/nodes/${node.id}`, {
        method: "PUT",
        body: JSON.stringify(changes(node, {
          price: Number(price || "0"),
          currency: form.currency,
          billing_cycle: form.billing_cycle,
          expires_at: form.expires_at || null,
        })),
      })
      toast.success("续费设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="价格" hint="留空或 0 为免费">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="免费"
              />
            </Field>
            <Field label="货币">
              <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["USD", "CNY", "EUR", "GBP", "JPY"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="付款周期">
              <Select value={form.billing_cycle} onValueChange={(v) => set("billing_cycle", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CYCLES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="到期时间" hint="YYYY-MM-DD；留空表示永不到期">
              <DatePicker value={form.expires_at ?? ""} onChange={(value) => set("expires_at", value)} />
            </Field>
          </div>
        </div>
        <p role="alert" className="field-error">{error}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The window lives on the hub; this reads it back and counts down, which is also
// what makes an expired one disappear from the panel without interaction.
function useRegisterWindow() {
  const [key, setKey] = useState("")
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    api<Settings>("/settings")
      .then((s) => { setKey(String(s.register_key ?? "")); setUntil(Number(s.register_until ?? 0)) })
      .catch(() => {})
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])

  return {
    key,
    left: key === "" ? 0 : Math.max(0, until - now),
    async open() {
      try {
        const w = await api<{ register_key: string; register_until: string }>("/register-window", { method: "POST" })
        setKey(w.register_key)
        setUntil(Number(w.register_until))
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
    async close() {
      try {
        await api("/register-window", { method: "DELETE" })
        setKey("")
        setUntil(0)
        toast.success("注册窗口已关闭")
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
  }
}

function RegisterDialog({ site, reg, onClose }: {
  site: string
  reg: ReturnType<typeof useRegisterWindow>
  onClose: () => void
}) {
  const command = reg.left > 0 ? registrationCommand(site, reg.key) : ""
  const clock = `${Math.floor(reg.left / 60)}:${String(reg.left % 60).padStart(2, "0")}`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量注册</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            在节点上运行以下命令：脚本从本 Hub 下载与你当前发行版精确匹配的 Agent，
            校验哈希后安装 systemd 服务。注册窗口持续一小时，新节点默认公开；命令包含
            短期注册密钥，请妥善保管，每台机器会换取自己的长期令牌。
          </p>
          {command ? (
            <div className="space-y-2">
              <Label className="text-sm font-medium">安装命令</Label>
              <pre className="h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all">
                {command}
              </pre>
              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                <span>
                  <span className="block font-medium">窗口 {clock} 后自动关闭</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    到点自动失效，装完了也可以现在就关
                  </span>
                </span>
                <Button variant="outline" size="sm" onClick={reg.close}>立即关闭</Button>
              </div>
            </div>
          ) : (
            <Button onClick={reg.open}>开启一小时窗口</Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            复制
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InstallDialog({ node, site, onClose, onRotated, onCloseAutoFocus }: {
  node: IssuedNode
  site: string
  onClose: () => void
  onRotated: () => void
} & ReturnFocus) {
  const [token, setToken] = useState(node.token ?? "")
  const [interval, setInterval] = useState("3")
  const [rotating, setRotating] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)

  const seconds = Number(interval)
  const intervalValid = /^\d+$/.test(interval) && seconds >= 3 && seconds <= 60
  const command = intervalValid ? agentCommand(site, seconds) : ""

  async function rotate() {
    setRotating(true)
    try {
      const fresh = await api<{ token: string }>(`/nodes/${node.id}/token`, { method: "POST" })
      setToken(fresh.token)
      setConfirmRotate(false)
      toast.success("凭证已换发，请保存并更新 Agent")
      onRotated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRotating(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>安装 Agent</DialogTitle>
          <DialogDescription>{node.name} · 接入标识 node-{node.id}。在节点运行安装命令并输入原节点令牌；令牌丢失时可换发，新令牌仅本次显示。</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="上报间隔（秒）" hint="3–60 秒，整数；默认 3 秒。">
            <Input type="number" min={3} max={60} step={1} value={interval} onChange={(e) => setInterval(e.target.value)} />
            <p className="field-error">{intervalValid ? "" : "请输入 3–60 的整数"}</p>
          </Field>
          <div className="space-y-2">
            <Label className="text-sm font-medium">安装命令</Label>
            <pre className="h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all">
              {command || "请填写有效的上报间隔。"}
            </pre>
          </div>
          {token && <div className="space-y-2"><Label>节点令牌（仅本次显示）</Label><pre className="break-all whitespace-pre-wrap border p-3 text-xs select-all">{token}</pre><Button variant="outline" onClick={() => copy(token)}>复制令牌</Button></div>}
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">换发凭证</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                旧凭证立即作废，agent 掉线，需用新命令启动 Agent
              </span>
            </span>
            <Button variant="outline" size="sm" disabled={rotating} onClick={() => setConfirmRotate(true)}>
              换发
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command || !intervalValid}>
            复制
          </Button>
        </DialogFooter>
      </DialogContent>
      {confirmRotate && (
        <ConfirmDialog
          title={`给「${node.name}」换发凭证？`}
          description="旧令牌会立即失效，已连接的 Agent 将断开。请在节点更新令牌后重新连接。"
          confirmLabel="换发凭证"
          busy={rotating}
          onClose={() => setConfirmRotate(false)}
          onConfirm={rotate}
        />
      )}
    </Dialog>
  )
}

function Nodes({ nodes, refresh, site, canProvision, distributionAvailable, onOpen }: { onOpen:(id:number)=>void; nodes: Node[]; refresh: () => void; site: string; canProvision: boolean; distributionAvailable: boolean }) {
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

function LoadState({ error, retry }: { error: string; retry: () => void }) {
  return error ? (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-destructive" role="alert">加载失败：{error}</p>
      <Button variant="outline" size="sm" onClick={retry}>重试</Button>
    </div>
  ) : (
    <div role="status" aria-label="加载中">
      <Skeleton className="h-32" />
    </div>
  )
}

function Ping({ nodes }: { nodes: Node[] }) {
  const [tasks, setTasks] = useState<PingTask[] | null>(null)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<Partial<PingTask> | null>(null)
  const [deleting, setDeleting] = useState<PingTask | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  const load = () => {
    setTasks(null)
    setError("")
    setReload((n) => n + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    api<{ tasks: PingTask[] }>("/ping-tasks", { signal: controller.signal })
      .then((d) => { if (!controller.signal.aborted) setTasks(d.tasks) })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message || "网络错误") })
    return () => controller.abort()
  }, [reload])

  async function save() {
    if (!editing) return
    if (!editing.name?.trim() || !editing.target?.trim()) return toast.error("请填写名称和目标")
    setSaving(true)
    try {
      await api("/ping-tasks", { method: "POST", body: JSON.stringify(editing) })
      toast.success("已保存，正在下发")
      setEditing(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/ping-tasks/${deleting.id}`, { method: "DELETE" })
      toast.success("监控已删除")
      setDeleting(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  const toggle = (id: number) =>
    setEditing((t) => {
      if (!t) return t
      const nodes = t.nodes ?? []
      return { ...t, nodes: nodes.includes(id) ? nodes.filter((n) => n !== id) : [...nodes, id] }
    })

  return (
    <div className="space-y-4">
      <div className="page-heading"><h1>监测</h1>
        <Button onClick={() => setEditing({ name: "", target: "", interval: 60, nodes: [] })}>
          添加监测
        </Button>
      </div>

      {tasks === null ? <LoadState error={error} retry={load} /> : <Card className="overflow-x-auto p-0">
        <Table className="monitoring-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">名称</TableHead>
              <TableHead className="w-[40%]">目标</TableHead>
              <TableHead className="w-[12%]">间隔</TableHead>
              <TableHead className="w-[12%]">节点</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="tnum text-sm">{t.target}</TableCell>
                <TableCell className="tnum text-sm">{t.interval}s</TableCell>
                <TableCell className="text-sm text-muted-foreground">{t.nodes.length} 个</TableCell>
                <TableCell><div className="monitoring-actions">
                  <Button variant="outline" onClick={() => setEditing(t)} aria-label="编辑监测">编辑</Button>
                  <Button variant="ghost" onClick={() => setDeleting(t)} aria-label="删除监测">
                    删除
                  </Button></div>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm whitespace-normal text-muted-foreground">
                  还没有监测任务。添加目标地址并选择节点。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>}

      {editing && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{editing.id ? "编辑监测" : "添加监测"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="名称">
                  {/* A new romi node starts empty, so the cursor belongs here;
                      editing an existing one starts with nothing selected. */}
                  <Input autoFocus={!editing.id} value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Cloudflare" />
                </Field>
                <Field label="间隔（秒）" hint="5–3600">
                  {/* `|| 60`, as the three other number boxes on this page do:
                      an emptied `type="number"` reads back as "", and Number("")
                      is 0 -- which the hub used to clamp into a 5-second probe on
                      every assigned node. It refuses that now, so this keeps a
                      cleared box from being a round trip to an error. */}
                  <Input type="number" min="5" max="3600" value={editing.interval ?? 60} onChange={(e) => setEditing({ ...editing, interval: Number(e.target.value) })} />
                </Field>
              </div>
              <Field label="目标地址" hint="host:port">
                <Input value={editing.target ?? ""} onChange={(e) => setEditing({ ...editing, target: e.target.value })} placeholder="1.1.1.1:443" />
              </Field>
              <div className="space-y-2">
                <Label className="text-sm font-medium">执行节点</Label>
                <div className="choice-list">
                  {nodes.map((n) => (
                    <label key={n.id} className="choice-row">
                      <input type="checkbox" checked={editing.nodes?.includes(n.id) ?? false} onChange={() => toggle(n.id)} className="accent-primary" />
                      {n.name}
                    </label>
                  ))}
                  {nodes.length === 0 && <p className="p-2 text-xs text-muted-foreground">先添加节点</p>}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button onClick={save} disabled={saving}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除监测「${deleting.name}」？`}
          description="该监控及其历史延迟记录一并删除，不可恢复。"
          confirmLabel="删除监测"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}

type Settings = Record<string,string|boolean>
function useSettings() {
  const [saved,setSaved]=useState<Settings>({})
  const [s, setS] = useState<Settings | null>(null)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<Settings>("/settings", { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) {setS(next);setSaved(next)} })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message || "网络错误") })
    return () => controller.abort()
  }, [reload])
  return {
    s,
    dirty:(keys:string[])=>keys.some(k=>(s?.[k]??"")!==(saved[k]??"")),
    error,
    retry: () => { setError(""); setReload((n) => n + 1) },
    set: (k: string, v: string) => setS((old) => ({ ...(old ?? {}), [k]: v })),
    // `null` when the save landed, otherwise the refusal. The errors are
    // reported here, so callers need not, but a caller that discards what it
    // just sent -- the password fields -- has to tell a rejection from a
    // success, and one that attributes a refusal to a particular field needs
    // its status.
    save: async (patch: Record<string, string>): Promise<Error | null> => {
      setError("")
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify(patch) })
        toast.success("已保存")
        // Only the saved keys and the `*_set` flags are taken from the hub: a
        // credential comes back as a flag, so the typed value must not linger,
        // while another card's unsaved edits on the same page must survive.
        const fresh = await api<Settings>("/settings")
        setSaved(fresh)
        setS((old) => {
          const next = { ...old }
          for (const key of Object.keys(patch)) next[key] = fresh[key]
          for (const [key, value] of Object.entries(fresh)) if (key.endsWith("_set")) next[key] = value
          return next
        })
        return null
      } catch (e) {
        setError((e as Error).message)
        toast.error((e as Error).message)
        return e as Error
      }
    },
  }
}

type GeoStatus = {state:string;received:number;error:string;configured:boolean}
function GeoSettings({url,setUrl}:{url:string;setUrl:(url:string)=>void}) {
  const [status,setStatus]=useState<GeoStatus|null>(null),[error,setError]=useState("")
  const [readError,setReadError]=useState("")
  const [busy,setBusy]=useState(false)
  useEffect(()=>{let cancelled=false;let timer:ReturnType<typeof setTimeout>;const load=()=>api<GeoStatus>("/geolite").then(v=>{if(!cancelled){setStatus(v);setReadError("");timer=setTimeout(load,v.state==="downloading"?500:3000)}}).catch(e=>{if(!cancelled){setReadError(e.message);timer=setTimeout(load,3000)}});void load();return()=>{cancelled=true;clearTimeout(timer)}},[])
  const update=async()=>{setBusy(true);setError("");try {await api("/settings",{method:"PUT",body:JSON.stringify({geolite_url:url})});await api("/geolite",{method:"POST"});setStatus({state:"downloading",received:0,error:"",configured:!!status?.configured})}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Card className="p-6 gap-4"><h2 className="text-sm font-medium">GeoLite2 Country</h2><Field label="HTTPS 数据库直链"><Input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://example.com/GeoLite2-Country.mmdb"/></Field>
    <p className="text-xs text-muted-foreground">{status ? status.configured?"已配置本地数据库":"未配置" : "正在读取状态"}{status?.state==="downloading"?` · 已下载 ${bytes(status.received)}`:status?.state==="complete"?" · 更新完成":status?.state==="cancelled"?" · 已取消":""}</p>
    <p role="alert" className="field-error">{error || readError || (status?.state==="cancelled" ? "" : status?.error)}</p><div className="flex gap-2"><Button disabled={busy || status?.state==="downloading" || !url.trim()} onClick={update}>{status?.state==="error"?"重试":"下载并更新"}</Button>{status?.state==="downloading"&&<Button variant="outline" onClick={()=>{setError("");void api("/geolite",{method:"DELETE"}).catch(e=>setError(e.message))}}>取消</Button>}</div></Card>
}
function SettingsTab() {
  const {s,set,save,error,retry}=useSettings()
  if(!s)return <LoadState error={error} retry={retry}/>
  return <div className="space-y-5">{error && <p role="alert" className="field-error">{error}</p>}<Card className="p-6 gap-4"><h2 className="text-sm font-medium">站点</h2><Field label="站点名称"><Input value={String(s.site_name??"")} onChange={e=>set("site_name",e.target.value)}/></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="分钟历史保留天数" hint="1–3650；小时历史保留一年"><Input type="number" min={1} max={3650} step={1} value={String(s.retention_days??"30")} onChange={e=>set("retention_days",e.target.value)}/></Field>
    <Field label="连续在线重置阈值（分钟）" hint="1–60；中断超过此时长后重新计时"><Input type="number" min={1} max={60} step={1} value={String(s.online_grace_minutes??"5")} onChange={e=>set("online_grace_minutes",e.target.value)}/></Field></div>
    <Field label="公开页默认视图"><Select value={String(s.public_default_view || "cards")} onValueChange={v=>set("public_default_view",v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="cards">卡片</SelectItem><SelectItem value="list">列表</SelectItem></SelectContent></Select></Field>
    <label className="choice-row"><Switch checked={s.public_page==="on"} onCheckedChange={v=>set("public_page",v?"on":"off")}/>开放公开状态页，关闭后所有页面需登录</label>
    <Button onClick={()=>save({site_name:String(s.site_name??""),retention_days:String(s.retention_days||"30"),online_grace_minutes:String(s.online_grace_minutes||"5"),public_page:s.public_page==="on"?"on":"off",public_default_view:String(s.public_default_view||"cards")})}>保存站点设置</Button></Card>
    <GeoSettings url={String(s.geolite_url??"")} setUrl={v=>set("geolite_url",v)}/></div>
}

const TEXTAREA = "font-mono"

// One offline alert, filled in the way the hub fills a template: in a single pass,
// JSON-escaped for the webhook body. Previews only; nothing here is sent.
const SAMPLE_NOTE: Record<string, string> = {
  event: "offline",
  node: "香港 · 甲商家",
  title: "🔴 香港 · 甲商家 离线",
  message: "最后上报 09-15 20:13 +08:00",
  time: "09-15 20:16 +08:00",
}

const PLACEHOLDERS = "{{title}} {{message}} {{node}} {{event}} {{site}} {{time}}"

function TemplatePreview({ template, site, json = false }: { template: string; site: string; json?: boolean }) {
  if (!template.trim()) return <p className="text-xs text-muted-foreground">留空保存即恢复默认模板</p>
  const values = { ...SAMPLE_NOTE, site }
  let out = template.replace(/\{\{(event|node|title|message|site|time)\}\}/g, (_, key: keyof typeof values) =>
    json ? JSON.stringify(values[key]).slice(1, -1) : values[key],
  )
  if (json) {
    try {
      out = JSON.stringify(JSON.parse(out), null, 2)
    } catch {
      return (
        <p className="rounded-md bg-secondary px-3 py-2 text-xs text-destructive">
          代入后不是合法 JSON，保存会被拒绝。占位符要写在引号里，例如 "text": "{"{{title}}"}"
        </p>
      )
    }
  }
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">预览（以一条离线通知为例）</div>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">{out}</pre>
    </div>
  )
}

// A channel's form, collapsed until needed. The summary carries whether the
// channel is configured, so the closed card still answers the common question.
function ChannelCard({ title, configured, children }: { title: string; configured: boolean; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
            {title}
          </span>
          <Badge variant={configured ? "secondary" : "outline"}>{configured ? "已配置" : "未配置"}</Badge>
        </summary>
        <div className="mt-4 space-y-4">{children}</div>
      </details>
    </Card>
  )
}

// Offline alerts are opt-in per node, so turning them on for a fleet needs one
// place rather than one dialog per node.
function OfflineNodes({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const [busy, setBusy] = useState(false)

  async function apply(targets: Node[], on: boolean) {
    setBusy(true)
    try {
      // Awaited in turn, the requests would cost one round trip per node, and
      // the two-second stream would render each one as it lands.
      await Promise.all(
        targets
          .filter((n) => !!n.notify !== on)
          .map((n) => api(`/nodes/${n.id}`, { method: "PUT", body: JSON.stringify({ notify: on }) })),
      )
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      refresh()
      setBusy(false)
    }
  }

  const enabled = nodes.filter((n) => n.notify).length
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">离线通知</h3>
          <p className="mt-1 text-xs text-muted-foreground">按节点打开，默认关。已打开 {enabled} / {nodes.length} 台</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy || enabled === nodes.length} onClick={() => apply(nodes, true)}>全部打开</Button>
          <Button size="sm" variant="ghost" disabled={busy || enabled === 0} onClick={() => apply(nodes, false)}>全部关闭</Button>
        </div>
      </div>
      {nodes.length > 0 && (
        <div className="choice-list choice-columns">
          {nodes.map((node) => (
            <label key={node.id} className="choice-row">
              <input type="checkbox" checked={!!node.notify} disabled={busy} onChange={e => apply([node], e.target.checked)} />
              <span>{node.name}</span>
            </label>
          ))}
        </div>
      )}
    </Card>
  )
}

function Notify({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const { s, set, save, error, retry, dirty } = useSettings()
  const [testing, setTesting] = useState(false)
  if (!s) return <LoadState error={error} retry={retry} />
  const text = (k: string) => String(s[k] ?? "")
  // A credential is sent only when something was typed: the field starts empty
  // because the hub never returns the stored value.
  const typed = (...keys: string[]) =>
    Object.fromEntries(keys.filter((k) => typeof s[k] === "string" && s[k] !== "").map((k) => [k, text(k)]))
  const secretHint = (k: string) => (s[`${k}_set`] ? "已设置，留空不变" : "未设置")

  async function test(channel:string) {
    setTesting(true)
    try {
      const { sent } = await api<{ sent: string[] }>(`/notify/test?channel=${channel}`, { method: "POST" })
      toast.success(`测试通知已发送：${sent.join("、")}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">{error && <p role="alert" className="field-error">{error}</p>}
      <ChannelCard title="Telegram" configured={!!s.notify_telegram_token_set && text("notify_telegram_chat") !== ""}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bot Token" hint={secretHint("notify_telegram_token")}>
            <Input
              type="password"
              autoComplete="off"
              placeholder={s.notify_telegram_token_set ? "••••••••" : "123456:ABC-DEF…"}
              value={text("notify_telegram_token")}
              onChange={(e) => set("notify_telegram_token", e.target.value)}
            />
          </Field>
          <Field label="Chat ID" hint="数字 ID，群组是负数；公开频道可填 @频道名">
            <Input value={text("notify_telegram_chat")} onChange={(e) => set("notify_telegram_chat", e.target.value)} placeholder="-1001234567890" />
          </Field>
        </div>
        <Field label="消息模板" hint={`纯文本。占位符 ${PLACEHOLDERS}`}>
          <Textarea rows={3} className={TEXTAREA} value={text("notify_telegram_text")} onChange={(e) => set("notify_telegram_text", e.target.value)} />
        </Field>
        <TemplatePreview template={text("notify_telegram_text")} site={text("site_name") || "Monitor"} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() =>
              save({
                notify_telegram_chat: text("notify_telegram_chat"),
                notify_telegram_text: text("notify_telegram_text"),
                ...typed("notify_telegram_token"),
              })
            }
          >
            保存 Telegram
          </Button><Button variant="outline" disabled={testing || !s.notify_telegram_token_set || !text("notify_telegram_chat") || dirty(["notify_telegram_token","notify_telegram_chat","notify_telegram_text"])} onClick={()=>test("telegram")}>发送测试</Button>
          {s.notify_telegram_token_set && (
            <Button size="sm" variant="ghost" onClick={() => save({ notify_telegram_token: "", notify_telegram_chat: "" })}>
              清除
            </Button>
          )}
        </div>
      </ChannelCard>

      <ChannelCard title="Webhook" configured={!!s.notify_webhook_url_set}>
        <Field label="URL" hint={secretHint("notify_webhook_url")}>
          <Input
            type="password"
            autoComplete="off"
            placeholder={s.notify_webhook_url_set ? "••••••••" : "https://…"}
            value={text("notify_webhook_url")}
            onChange={(e) => set("notify_webhook_url", e.target.value)}
          />
        </Field>
        <Field label="请求头" hint={`可选，一行一个。${s.notify_webhook_headers_set ? "已设置，留空不变" : ""}`}>
          <Textarea
            rows={2}
            className={TEXTAREA}
            placeholder={s.notify_webhook_headers_set ? "••••••••" : "Authorization: Bearer xxx"}
            value={text("notify_webhook_headers")}
            onChange={(e) => set("notify_webhook_headers", e.target.value)}
          />
        </Field>
        <Field label="请求体" hint={`以 POST 发送，Content-Type 为 application/json。占位符 ${PLACEHOLDERS}，须写在引号内`}>
          <Textarea rows={4} className={TEXTAREA} value={text("notify_webhook_body")} onChange={(e) => set("notify_webhook_body", e.target.value)} />
        </Field>
        <TemplatePreview template={text("notify_webhook_body")} site={text("site_name") || "Monitor"} json />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => save({ notify_webhook_body: text("notify_webhook_body"), ...typed("notify_webhook_url", "notify_webhook_headers") })}
          >
            保存 Webhook
          </Button><Button variant="outline" disabled={testing || !s.notify_webhook_url_set || dirty(["notify_webhook_url","notify_webhook_headers","notify_webhook_body"])} onClick={()=>test("webhook")}>发送测试</Button>
          {s.notify_webhook_headers_set && (
            <Button size="sm" variant="ghost" onClick={() => save({ notify_webhook_headers: "" })}>
              清除请求头
            </Button>
          )}
          {s.notify_webhook_url_set && (
            <Button size="sm" variant="ghost" onClick={() => save({ notify_webhook_url: "", notify_webhook_headers: "" })}>
              清除
            </Button>
          )}
        </div>
      </ChannelCard>

      <OfflineNodes nodes={nodes} refresh={refresh} />

      <Card className="gap-4 p-5">
        <h3 className="text-sm font-medium">事件</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="离线宽限期（分钟）" hint="断开超过这么久才算离线，1–30">
            <Input type="number" min={1} max={30}value={text("notify_grace")} onChange={(e) => set("notify_grace", e.target.value)} />
          </Field>
          <Field label="流量提醒（%）" hint="本期用量达到该比例和 100% 时各提醒一次，0 关闭">
            <Input type="number" min={0} max={100} value={text("notify_traffic")} onChange={(e) => set("notify_traffic", e.target.value)} />
          </Field>
          <Field label="到期提醒（天）" hint="每天 9 点汇总这么多天内到期的节点，自动续期时也提醒，0 关闭">
            <Input type="number" min={0} max={365} value={text("notify_expiry")} onChange={(e) => set("notify_expiry", e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch aria-labelledby="notify-login-label" checked={s.notify_login !== "off"} onCheckedChange={(v) => set("notify_login", v ? "on" : "off")} />
          <span id="notify-login-label">登录后台时提醒</span>
        </div>
        <div>
          <Button
            size="sm"
            onClick={() =>
              save({
                notify_grace: text("notify_grace"),
                notify_traffic: text("notify_traffic"),
                notify_expiry: text("notify_expiry"),
                notify_login: s.notify_login === "off" ? "off" : "on",
              })
            }
          >
            保存事件设置
          </Button>
        </div>
      </Card>
    </div>
  )
}

// The two ways into this panel, on their own page: the GitHub identity it trusts
// and the password that works when GitHub does not.
type Session = { id: string; current: boolean; created_at: number }

function Sessions() {
  const [rows, setRows] = useState<Session[] | null>(null)
  const [busy, setBusy] = useState("")

  const load = () => api<Session[]>("/sessions").then(setRows).catch((e: Error) => toast.error(e.message))
  useEffect(() => { load() }, [])

  async function remove(id: string) {
    setBusy(id)
    try {
      await api(`/sessions/${id}`, { method: "DELETE" })
      toast.success("已删除会话")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  if (!rows) return null
  return (
    <Card className="gap-4 p-5">
      <div>
        <h3 className="text-sm font-medium">登录会话</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          每次登录一条，14 天后过期。删除后该设备下一次请求就被登出。
        </p>
      </div>
      <div className="divide-y">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="tnum">{new Date(s.created_at * 1000).toLocaleString()}</span>
              {s.current && <Badge variant="secondary">当前设备</Badge>}
            </div>
            {/* 当前会话没有删除按钮：右上角的退出登录做的就是这件事，而在这里删
                只会让已经渲染好的面板以为自己还登着。 */}
            {!s.current && (
              <Button size="icon" variant="ghost" title="删除会话" disabled={!!busy} onClick={() => remove(s.id)}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

function Security({ site }: { site: string }) {
  const { s, set, save, error, retry } = useSettings()
  const [password, setPassword] = useState("")
  const [current, setCurrent] = useState("")
  const [currentError, setCurrentError] = useState("")
  if (!s) return <LoadState error={error} retry={retry} />
  const callback = `${site}/api/auth/github/callback`

  return (
    <div className="space-y-4">{error && <p role="alert" className="field-error">{error}</p>}
      <Sessions />

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">GitHub 单点登录</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            OAuth App 回调地址 <code className="break-all rounded bg-muted px-1">{callback}</code>
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID">
            <Input value={String(s.github_client_id ?? "")} onChange={(e) => set("github_client_id", e.target.value)} />
          </Field>
          <Field label="Client Secret" hint={s.github_secret_set ? "已设置，留空不变" : "未设置"}>
            {/* Controlled, so that saving empties it. The hub answers with a
                `github_secret_set` flag and never the secret itself, so an
                uncontrolled field kept the typed value on screen after a save
                that had already stored it. */}
            <Input type="password" value={String(s.github_client_secret ?? "")} placeholder={s.github_secret_set ? "••••••••" : ""} onChange={(e) => set("github_client_secret", e.target.value)} />
          </Field>
        </div>
        {String(s.github_client_id ?? "") !== "" && String(s.github_allowed_users ?? "").trim() === "" && (
          <p className="rounded-md bg-secondary px-3 py-2 text-sm text-destructive">
            白名单为空，GitHub 登录拒绝所有人。填入用户名并保存后生效。
          </p>
        )}
        <Field label="允许登录的 GitHub 用户名" hint="逗号分隔。留空 = 拒绝所有人，不是放行所有人">
          <Input value={String(s.github_allowed_users ?? "")} onChange={(e) => set("github_allowed_users", e.target.value)} placeholder="GitHub 用户名" />
        </Field>
        <div>
          <Button
            size="sm"
            onClick={() => {
              const patch: Record<string, string> = {
                github_client_id: String(s.github_client_id ?? ""),
                github_allowed_users: String(s.github_allowed_users ?? ""),
              }
              if (typeof s.github_client_secret === "string" && s.github_client_secret) {
                patch.github_client_secret = s.github_client_secret
              }
              save(patch)
            }}
          >
            保存 GitHub 设置
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">账号与密码</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            修改账号或密码后，其他设备的登录会话失效。
          </p>
        </div>
        <Field label="账号"><Input value={String(s.admin_username ?? "admin")} onChange={e=>set("admin_username",e.target.value)}/></Field>
        <Field label="当前密码" hint="修改账号或密码都需要先验证当前密码。" error={currentError}>
          <Input type="password" value={current} onChange={(e) => { setCurrent(e.target.value); setCurrentError("") }} autoComplete="current-password" />
        </Field>
        <Field label="新密码" hint="至少 12 位">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button
            size="sm"
            disabled={password.length < 12 || current === ""}
            onClick={() =>
              save({
                admin_username: String(s.admin_username ?? "admin"),
                admin_password: password,
                current_password: current,
              }).then((failure) => {
                // Cleared only once the hub accepted it. A rejected change that
                // empties the fields leaves the operator retyping a password the
                // panel never said it refused.
                if (!failure) {
                  setPassword("")
                  setCurrent("")
                  return
                }
                // A wrong password is the one refusal that belongs on a field.
                // Anything else is a failure of the request, which `save`
                // already reported.
                const refused = failure instanceof ApiError && failure.status === 403
                setCurrentError(refused ? "当前密码不正确" : "")
              })
            }
          >
            修改密码
          </Button>
        </div>
      </Card>
    </div>
  )
}

type DbInfo = {
  path: string
  size: number
  wal: number
  /** Space DuckDB reports as reusable inside the file. Reclaimed only by a rewrite. */
  free: number
  /** Timestamp of the earliest history row, null on a database with none. */
  oldest: number | null
  retention: number
  rows: Record<string, number>
  /** The storage engine and the application schema it is running, for the record. */
  engine: string
  schema: number | null
  /** Writer-queue counters. `committed_ops_total` counts operations, not batches. */
  queue: {
    queued_ops_current: number
    queue_capacity: number
    accepted_ops_total: number
    committed_ops_total: number
    refused_ops_total: number
    failed_ops_total: number
    batch_transactions_total: number
    batch_ops_total: number
    max_batch_size: number
    average_batch_size: number
    queue_wait_us_avg: number
    transaction_us_avg: number
  }
}

// The only two tables whose row count indicates anything about size. Every other
// holds one row per node or per key.
const DB_ROWS: [string, string][] = [
  ["metric", "历史明细"],
  ["ping_record", "延迟记录"],
]

function Data() {
  const maintenanceSettings=useSettings()
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [confirm, setConfirm] = useState<"maintenance" | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  // Closing the dialog must stop the upload rather than merely hide it: restore
  // is the one irreversible action here, and it takes minutes on a large
  // backup.
  const abort = useRef<AbortController | null>(null)
  // Leaving the section stops an unfinished restore, as the dialog's cancel
  // does. Otherwise it ran on unseen, replaced the database, and reloaded the
  // page under whatever the operator had moved on to.
  useEffect(() => () => abort.current?.abort(), [])
  const picker = useRef<HTMLInputElement>(null)

  const load = () => api<DbInfo>("/db").then((data) => { setInfo(data); setError("") }).catch((e: Error) => setError(e.message || "网络错误"))
  useEffect(() => { load() }, [])

  async function maintenance() {
    setBusy("maintenance")
    try {
      const { pruned, freed, compacted, reusable } = await api<{
        pruned: number
        freed: number
        compacted: boolean
        reusable: number
      }>("/db/maintenance", { method: "POST" })
      // `freed` is measured, not estimated: it is the difference in bytes on disk
      // before and after. When a rewrite was not worth it the count says so rather
      // than inventing a figure.
      toast.success(
        compacted
          ? `已清理 ${pruned} 行，重写文件后实际回收 ${bytes(freed)}`
          : `已清理 ${pruned} 行，可复用 ${bytes(reusable)} 未达重写阈值，本次未重写文件`,
      )
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setConfirm(null)
    }
  }

  async function restore(file: File) {
    setBusy("restore")
    setSent(0)
    abort.current = new AbortController()
    try {
      await upload("/db/restore", file, setSent, abort.current.signal)
      toast.success("已恢复，正在重新加载")
      // Every node, setting and session on the page came from the database just
      // replaced.
      setTimeout(() => location.reload(), 800)
    } catch (e) {
      // Aborting partway is not a failure: the hub replaces nothing until the
      // last chunk, so the original database remains.
      const aborted = (e as Error).name === "AbortError"
      if (aborted) toast.info("已取消，数据库没有改动")
      else toast.error((e as Error).message)
      setBusy("")
    }
    setPending(null)
  }

  if (!info) return <LoadState error={error} retry={load} />
  const stat = (label: string, value: string) => (
    <div key={label}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 text-sm">{value}</div>
    </div>
  )

  return (
    <div className="space-y-4">
      {error && <LoadState error={error} retry={load} />}
      <Card className="gap-4 p-5">
        <h3 className="text-sm font-medium">数据库</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stat("文件大小", bytes(info.size))}
          {stat("预写日志", bytes(info.wal))}
          {stat("可复用空间", bytes(info.free))}
          {stat("保留天数", `${info.retention} 天`)}
          {/* 和保留天数并排：跨度小于保留期是还没攒够，大于保留期就是每小时
              那次 prune 没在跑。 */}
          {stat("历史跨度", info.oldest ? `${Math.floor((Date.now() / 1000 - info.oldest) / 86400)} 天` : "—")}
          {DB_ROWS.map(([key, label]) => stat(label, (info.rows[key] ?? 0).toLocaleString()))}
        </div>

      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">数据库维护</h3>
          {maintenanceSettings.s && <div className="my-4 flex items-end gap-3"><Field label="自动维护周期"><Select value={String(maintenanceSettings.s.maintenance_days || "0")} onValueChange={v=>maintenanceSettings.set("maintenance_days",v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{[0,7,30,90,180].map(n=><SelectItem key={n} value={String(n)}>{n ? `每 ${n} 天` : "关闭"}</SelectItem>)}</SelectContent></Select></Field><Button onClick={()=>maintenanceSettings.save({maintenance_days:String(maintenanceSettings.s?.maintenance_days || "0")})}>保存周期</Button></div>}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            清理过期历史明细，累计流量保持不变。请预留至少与数据库等量的空闲磁盘；维护期间写入可能短暂等待。
          </p>
        </div>
        <div>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirm("maintenance")}>
            {busy === "maintenance" ? "维护中…" : "立即维护"}
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">备份</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            备份包含凭据摘要，请勿公开。仅导入此处导出的备份文件；恢复会替换节点、设置和历史，并使所有登录失效。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* The browser's own download: the file is streamed straight from
              the response, never held in the page. */}
          <Button size="sm" asChild>
            <a href="/api/db/backup" download>
              导出备份
            </a>
          </Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => picker.current?.click()}>
            导入备份
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              setPending(e.target.files?.[0] ?? null)
              e.target.value = ""
            }}
          />
        </div>
      </Card>

      {confirm === "maintenance" && (
        <ConfirmDialog
          title="运行数据库维护？"
          description="将删除超出保留期的历史明细。累计流量不受影响，维护期间写入可能短暂等待。"
          confirmLabel="开始维护"
          busy={!!busy}
          onClose={() => setConfirm(null)}
          onConfirm={maintenance}
        />
      )}
      {pending && (
        <ConfirmDialog
          title="用备份覆盖当前数据？"
          description={`将用 ${pending.name}（${bytes(pending.size)}）整体替换当前数据库。当前的节点、设置和历史全部丢失，且无法撤销。`}
          confirmLabel={busy === "restore" ? `已上传 ${bytes(sent)} / ${bytes(pending.size)}` : "确认恢复"}
          busy={!!busy}
          onClose={() => { abort.current?.abort(); setPending(null) }}
          onConfirm={() => restore(pending)}
        />
      )}
    </div>
  )
}

// Each area is its own route rather than a tab, so a page can be linked to and a
// reload returns to the same section.
export function Admin({
  path,
  nodes,
  refresh,
  site,
  canProvision,
  distributionAvailable,
  onOpen,
}: {
  path: string
  nodes: Node[]
  refresh: () => void
  site: string
  canProvision: boolean
  distributionAvailable: boolean
  onOpen:(id:number)=>void
}) {
  return (
    <div className={`flex flex-col gap-5 ${["/admin/settings","/admin/data","/admin/security","/admin/notify"].includes(path) ? "settings-page" : ""}`}>
      <div className="min-w-0 flex-1">
        {path === "/admin/ping" ? (
          <Ping nodes={nodes} />
        ) : path === "/admin/notify" ? (
          <Notify nodes={nodes} refresh={refresh} />
        ) : path === "/admin/data" ? (
          <Data />

        ) : path === "/admin/security" ? (
          <Security site={site} />
        ) : path === "/admin/settings" ? (
          <SettingsTab />
        ) : (
          <Nodes onOpen={onOpen} nodes={nodes} refresh={refresh} site={site} canProvision={canProvision} distributionAvailable={distributionAvailable} />
        )}
      </div>
    </div>
  )
}
