import { useEffect, useId, useRef, useState } from "react"
import { ChevronRight } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { parseDate } from "@/lib/calendar"
import { DatePicker } from "@/components/ui/date-picker"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { agentCommand, api, changes, GIB, registrationCommand, trafficCorrection, type Node } from "@/lib/api"
import { CYCLES } from "@/lib/format"

import { copy, type ReturnFocus, ConfirmDialog, type Settings } from "./common"

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

export type IssuedNode = Pick<Node, "id" | "name"> & { token?: string }

export function CreateNode({ onClose, onSaved, onCloseAutoFocus }: {
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
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

export function NodeForm({ node, onClose, onSaved, onCloseAutoFocus }: {
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
        <div className="space-y-4">
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
            <label className="choice-row"><input type="checkbox" checked={sameBandwidth} onChange={e=>{if(!e.target.checked)set("bandwidth_up",form.bandwidth_down??0);setSameBandwidth(e.target.checked)}}/><span>上传与下载相同</span></label>
            {!sameBandwidth && <BandwidthField label="上传带宽" value={form.bandwidth_up ?? 0} onChange={v=>set("bandwidth_up",v)}/>}
          </fieldset>
          <p role="alert" className="field-error">{formError}</p>
          <details className="group border bg-muted/30 px-3 py-2.5">
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
          <label className="choice-row">
            <Switch checked={!!form.notify} onCheckedChange={(v) => set("notify", v)} />
            <span>
              <span className="block">离线通知</span>
              <span className="block text-xs text-muted-foreground">掉线超过宽限期推送一条，恢复在线时再推一条</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BillingForm({ node, onClose, onSaved, onCloseAutoFocus }: {
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
        <div className="space-y-4">
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
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The window lives on the hub; this reads it back and counts down, which is also
// what makes an expired one disappear from the panel without interaction.
export function useRegisterWindow() {
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

export function RegisterDialog({ site, reg, onClose }: {
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
            校验哈希后安装系统服务（systemd 或 OpenRC）。注册窗口持续一小时，新节点默认公开；命令包含
            短期注册密钥，请妥善保管，每台机器会换取自己的长期令牌。
          </p>
          {command ? (
            <div className="space-y-2">
              <Label className="text-sm font-medium">安装命令</Label>
              <pre className="h-24 overflow-auto whitespace-pre-wrap break-all border bg-muted/40 p-3 text-xs leading-relaxed select-all">
                {command}
              </pre>
              <div className="flex items-center justify-between gap-4 border bg-muted/30 px-3 py-2.5 text-sm">
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
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            复制
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InstallDialog({ node, site, onClose, onRotated, onCloseAutoFocus }: {
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
        </DialogHeader>
        <DialogDescription>{node.name} · 接入标识 node-{node.id}。在节点运行安装命令并输入原节点令牌；令牌丢失时可换发，新令牌仅本次显示。</DialogDescription>
        <div className="space-y-4">
          <Field label="上报间隔（秒）" hint="3–60 秒，整数；默认 3 秒。">
            <Input type="number" min={3} max={60} step={1} value={interval} onChange={(e) => setInterval(e.target.value)} />
            <p className="field-error">{intervalValid ? "" : "请输入 3–60 的整数"}</p>
          </Field>
          <div className="space-y-2">
            <Label className="text-sm font-medium">安装命令</Label>
            <pre className="h-28 overflow-auto whitespace-pre-wrap break-all border bg-muted/40 p-3 text-xs leading-relaxed select-all">
              {command || "请填写有效的上报间隔。"}
            </pre>
          </div>
          {token && <div className="space-y-2"><Label>节点令牌（仅本次显示）</Label><pre className="break-all whitespace-pre-wrap border p-3 text-xs select-all">{token}</pre><Button variant="outline" onClick={() => copy(token)}>复制令牌</Button></div>}
          <div className="flex items-center justify-between gap-4 border bg-muted/30 px-3 py-2.5 text-sm">
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
          <Button variant="outline" onClick={onClose}>关闭</Button>
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
