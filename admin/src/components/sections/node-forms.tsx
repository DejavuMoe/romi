import { useEffect, useRef, useState, type FormEvent } from "react"
import { T } from "../../../../shared/i18n.ts"
import { numericError } from "../../../../shared/validate.ts"
import { agentCommand, api, changes, GIB, registrationCommand, trafficCorrection, type Node } from "@/lib/api"
import { parseDate } from "@/lib/calendar"
import { type Settings } from "./common"
import { nodeFacts, MeterRow, systemLine } from "../../../../web/src/components/Fleet"
import { QuotaBar, Ring } from "../../../../web/src/components/charts"
import { Button, Check, Field, Input, Segmented, Select, Switch, Tabs } from "../../../../web/src/components/ui/controls"
import { CodeBlock, CopyValue, Notice, toast } from "../../../../web/src/components/ui/feedback"
import { Icon } from "../../../../web/src/components/ui/icon"
import { Confirm, Dialog, DialogTitle } from "../../../../web/src/components/ui/overlay"
import { Fact, FlowValue, Region, StatusBadge, VitalTile } from "../../../../web/src/components/ui/status"
import { bandwidth, continuousUptime, CYCLES, expiry, full, MODES, pair, price, tone } from "../../../../web/src/lib/format"
import { spark } from "../../../../web/src/lib/api"

export type InspectTab = "overview" | "settings" | "billing" | "install"
type IssuedNode = { id: number; name: string; token: string }
const COUNTERS = ["total_rx", "total_tx", "month_rx", "month_tx"] as const
const counterText = (value: number) => String(Number((value / GIB).toFixed(3)))

function BandwidthField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [unit, setUnit] = useState(value >= 1000 ? "Gbps" : "Mbps")
  const [raw, setRaw] = useState(String(value / (unit === "Gbps" ? 1000 : 1)))
  const scale = unit === "Gbps" ? 1000 : 1
  const error = numericError(raw, { max: 1000000 / scale, step: "any", required: true })
  return <Field label={label} hint={T("0 表示未设置")} error={error}>
    <Input inputMode="decimal" value={raw} onChange={e => {
      const text = e.target.value
      setRaw(text)
      onChange(numericError(text, { max: 1000000 / scale, step: "any", required: true }) ? NaN : Number(text) * scale)
    }} suffix={<select className="input-unit" aria-label={T("{label}单位", { label })} value={unit} onChange={e => {
      const next = e.target.value
      if (!error) setRaw(String(value / (next === "Gbps" ? 1000 : 1)))
      setUnit(next)
    }}><option>Mbps</option><option>Gbps</option></select>} />
  </Field>
}

function SettingsForm({ node, onSaved, onDelete }: { node: Node; onSaved: () => void; onDelete: () => void }) {
  const [base, setBase] = useState(node)
  const [form, setForm] = useState(node)
  const [priority, setPriority] = useState(String(node.priority ?? 0))
  const [same, setSame] = useState(node.bandwidth_up === node.bandwidth_down)
  const [reset, setReset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const set = <K extends keyof Node>(key: K, value: Node[K]) => setForm(f => ({ ...f, [key]: value }))
  const errors = { name: form.name.trim() ? "" : T("请填写节点名称"), priority: numericError(priority, { max: 999999, required: true }) }
  const invalid = !!errors.name || !!errors.priority || [form.bandwidth_down ?? 0, same ? form.bandwidth_down ?? 0 : form.bandwidth_up ?? 0].some(value => !Number.isFinite(value) || value < 0 || value > 1000000)
  const values = { name: form.name.trim(), remark: form.remark ?? "", priority: Number(priority), public: form.public,
    has_ipv4: form.has_ipv4 ?? true, has_ipv6: form.has_ipv6 ?? false,
    bandwidth_down: form.bandwidth_down ?? 0, bandwidth_up: same ? form.bandwidth_down ?? 0 : form.bandwidth_up ?? 0, notify: !!form.notify }
  const patch = changes(base, values)
  const dirty = Object.keys(patch).length > 0
  const restore = () => { setForm(base); setPriority(String(base.priority ?? 0)); setSame(base.bandwidth_up === base.bandwidth_down); setReset(n => n + 1); setError("") }
  async function save(e: FormEvent) {
    e.preventDefault()
    if (invalid || !dirty || busy) return
    setBusy(true); setError("")
    try {
      await api("/nodes/" + node.id, { method: "PUT", body: JSON.stringify(patch) })
      setBase({ ...base, ...patch })
      toast(T("节点已保存")); onSaved()
    } catch (e) { setError(T((e as Error).message)) }
    finally { setBusy(false) }
  }
  return <form className="inspector-form" noValidate onSubmit={save}>
    <Field label={T("名称")} error={errors.name}><Input value={form.name} maxLength={128} onChange={e => set("name", e.target.value)} /></Field>
    <Field label={T("备注")} hint={T("仅管理员可见")} optional><Input value={form.remark ?? ""} placeholder={T("商家、用途")} onChange={e => set("remark", e.target.value)} /></Field>
    <div className="form-grid">
      <Field label={T("展示优先级")} hint={T("0–999999 整数，数字越大越靠前")} error={errors.priority}><Input inputMode="numeric" value={priority} onChange={e => setPriority(e.target.value)} /></Field>
      <div className="field"><span className="field-label">{T("公开状态页")}</span><Segmented label={T("公开状态页")} value={form.public ? "public" : "private"} onChange={v => set("public", v === "public")} options={[{ value: "public", label: T("显示") }, { value: "private", label: T("不显示") }]} /><p className="field-message">{T("私有节点只在管理列表显示。")}</p></div>
    </div>
    <fieldset className="form-set"><legend>{T("网络")}</legend>
      <div className="form-grid">{(["has_ipv4", "has_ipv6"] as const).map((key, i) => <div className="field" key={key}><span className="field-label">{i ? "IPv6" : "IPv4"}</span>
        <Segmented label={i ? "IPv6" : "IPv4"} value={(form[key] ?? !i) ? "yes" : "no"} onChange={v => set(key, v === "yes")} options={[{ value: "yes", label: T("有") }, { value: "no", label: T("无") }]} /></div>)}</div>
      <div className="form-grid">
        <BandwidthField key={"down-" + reset} label={same ? T("可用带宽") : T("下载带宽")} value={form.bandwidth_down ?? 0} onChange={v => set("bandwidth_down", v)} />
        {!same && <BandwidthField key={"up-" + reset} label={T("上传带宽")} value={form.bandwidth_up ?? 0} onChange={v => set("bandwidth_up", v)} />}
      </div>
      <Check checked={same} onChange={v => { if (!v) set("bandwidth_up", form.bandwidth_down ?? 0); setSame(v) }}>{T("上传与下载相同")}</Check>
    </fieldset>
    <Switch checked={!!form.notify} onChange={v => set("notify", v)} label={T("离线通知")} detail={T("掉线超过宽限期推送一条，恢复在线时再推一条")} />
    {error && <Notice tone="bad">{error}</Notice>}
    <div className="inspector-actions"><span className="dirty-note">{dirty ? T("有未保存的修改") : ""}</span>
      <Button onClick={restore} disabled={!dirty || busy}>{T("还原")}</Button><Button kind="primary" type="submit" busy={busy} disabled={!dirty || invalid}>{T("保存")}</Button></div>
    <div className="danger-zone"><div><p className="danger-title">{T("删除节点")}</p><p className="danger-detail">{T("历史指标、流量记录和凭证一并删除，不可恢复。")}</p></div><Button kind="danger-ghost" icon="trash-2" onClick={onDelete}>{T("删除节点")}</Button></div>
  </form>
}

function billingValues(node: Node) {
  const unit = node.traffic_unit === "TB" ? "TB" : "GB"
  return { price: node.price ? String(node.price) : "", currency: node.currency, billing_cycle: node.billing_cycle,
    expires_at: node.expires_at ?? "", limit: String(Number((node.traffic_limit / GIB / (unit === "TB" ? 1024 : 1)).toFixed(3))),
    unit, traffic_mode: node.traffic_mode, reset: String(node.traffic_reset_day),
    total_rx: counterText(node.total_rx), total_tx: counterText(node.total_tx), month_rx: counterText(node.month_rx), month_tx: counterText(node.month_tx) }
}

function BillingForm({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const [base, setBase] = useState(() => billingValues(node))
  const [v, setV] = useState(base)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const set = <K extends keyof typeof v>(key: K, value: (typeof v)[K]) => setV(old => ({ ...old, [key]: value }))
  const errors = { price: numericError(v.price, { step: 0.01 }), expires_at: v.expires_at && !parseDate(v.expires_at) ? T("到期时间须为有效的 YYYY-MM-DD 日期") : "",
    limit: numericError(v.limit, { step: "any", required: true }), reset: numericError(v.reset, { min: 1, max: 31, required: true }),
    ...Object.fromEntries(COUNTERS.map(key => [key, numericError(v[key], { step: "any" })])) } as Record<string, string>
  const invalid = Object.values(errors).some(Boolean)
  const dirty = Object.keys(changes(base, v)).length > 0
  async function save(e: FormEvent) {
    e.preventDefault()
    if (invalid || !dirty || busy) return
    const patch: Partial<Node> = {}
    for (const key of ["currency", "billing_cycle", "traffic_mode"] as const) if (v[key] !== base[key]) patch[key] = v[key]
    if (v.price !== base.price) patch.price = Number(v.price || 0)
    if (v.expires_at !== base.expires_at) patch.expires_at = v.expires_at || null
    if (v.reset !== base.reset) patch.traffic_reset_day = Number(v.reset)
    if (v.unit !== base.unit) patch.traffic_unit = v.unit
    if (v.limit !== base.limit || v.unit !== base.unit) patch.traffic_limit = Math.round(Number(v.limit) * GIB * (v.unit === "TB" ? 1024 : 1))
    const correction = trafficCorrection(Object.fromEntries(COUNTERS.map(key => [key, base[key]])), Object.fromEntries(COUNTERS.map(key => [key, v[key]])))
    if ([patch.traffic_limit, ...Object.values(correction)].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      return setError(T("流量必须是有效的非负数，且不能超出精确计数范围"))
    }
    setBusy(true); setError("")
    try {
      if (Object.keys(patch).length) await api("/nodes/" + node.id, { method: "PUT", body: JSON.stringify(patch) })
      if (Object.keys(correction).length) await api("/nodes/" + node.id + "/traffic", { method: "PUT", body: JSON.stringify(correction) })
      setBase({ ...v }); toast(T("账单与流量已保存")); onSaved()
    } catch (e) { setError(T((e as Error).message)) }
    finally { setBusy(false) }
  }
  return <form className="inspector-form" noValidate onSubmit={save}>
    <fieldset className="form-set"><legend>{T("账单")}</legend><div className="form-grid">
      <Field label={T("价格")} hint={T("留空或 0 为免费")} error={errors.price}><Input inputMode="decimal" value={v.price} onChange={e => set("price", e.target.value)} placeholder={T("免费")}
        suffix={<select className="input-unit" aria-label={T("货币")} value={v.currency} onChange={e => set("currency", e.target.value)}>{["USD", "CNY", "EUR", "GBP", "JPY"].map(c => <option key={c}>{c}</option>)}</select>} /></Field>
      <Field label={T("付款周期")}><Select value={v.billing_cycle} onChange={e => set("billing_cycle", e.target.value)}>{Object.entries(CYCLES).map(([key, label]) => <option key={key} value={key}>{T(label)}</option>)}</Select></Field></div>
      <Field label={T("到期时间")} hint={T("YYYY-MM-DD；留空表示永不到期")} error={errors.expires_at}><Input type="date" value={v.expires_at} onChange={e => set("expires_at", e.target.value)} /></Field>
    </fieldset>
    <fieldset className="form-set"><legend>{T("流量")}</legend><div className="form-grid">
      <Field label={T("每月流量额度")} hint={T("0 表示不限")} error={errors.limit}><Input inputMode="decimal" value={v.limit} onChange={e => set("limit", e.target.value)}
        suffix={<select className="input-unit" aria-label={T("额度单位")} value={v.unit} onChange={e => {
          const unit = e.target.value
          if (!errors.limit) set("limit", String(Number((Number(v.limit) * (unit === "TB" ? 1 / 1024 : 1024)).toFixed(3))))
          set("unit", unit)
        }}><option>GB</option><option>TB</option></select>} /></Field>
      <Field label={T("每月重置日")} hint={T("1–31。本月流量按新周期重算，总流量不变")} error={errors.reset}><Input inputMode="numeric" value={v.reset} onChange={e => set("reset", e.target.value)} /></Field></div>
      <div className="field"><span className="field-label">{T("流量计算方式")}</span><Segmented label={T("流量计算方式")} value={v.traffic_mode} onChange={value => set("traffic_mode", value)} options={Object.entries(MODES).map(([value, label]) => ({ value, label: T(label) }))} /></div>
      <details className="disclosure"><summary><Icon name="chevron-right" size={14} />{T("流量校正")}</summary><p className="muted small">{T("按 GB 填入需要校正的值，未修改的计数器继续正常累计。")}</p>
        <div className="form-grid">{COUNTERS.map((key, i) => <Field key={key} label={[T("累计下行"), T("累计上行"), T("本月下行"), T("本月上行")][i] + " (GB)"} error={errors[key]}><Input inputMode="decimal" value={v[key]} onChange={e => set(key, e.target.value)} /></Field>)}</div></details>
    </fieldset>
    {error && <Notice tone="bad">{error}</Notice>}
    <div className="inspector-actions"><span className="dirty-note">{dirty ? T("有未保存的修改") : ""}</span><Button onClick={() => { setV(base); setError("") }} disabled={!dirty || busy}>{T("还原")}</Button><Button kind="primary" type="submit" busy={busy} disabled={!dirty || invalid}>{T("保存")}</Button></div>
  </form>
}

function IntervalField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Field label={T("上报间隔（秒）")} hint={T("3–60 秒，整数；默认 3 秒。")} error={numericError(value, { min: 3, max: 60, required: true }) ? T("请输入 3–60 的整数") : ""}>
    <Input inputMode="numeric" value={value} onChange={e => onChange(e.target.value)} />
  </Field>
}
function TokenReveal({ token }: { token: string }) {
  return <div className="token-reveal"><Notice tone="warn" icon="key-round">{T("节点令牌仅本次显示，关闭后无法再次查看。安装时按提示输入。")}</Notice><CodeBlock code={token} label={T("复制令牌")} /></div>
}

function InstallPanel({ node, site, canProvision, distributionAvailable, onSaved }: { node: Node; site: string; canProvision: boolean; distributionAvailable: boolean; onSaved: () => void }) {
  const [interval, setInterval] = useState("3")
  const [token, setToken] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const allowed = canProvision && distributionAvailable
  const valid = !numericError(interval, { min: 3, max: 60, required: true })
  async function rotate() {
    if (!allowed || busy) return
    setBusy(true)
    try {
      const fresh = await api<{ token: string }>("/nodes/" + node.id + "/token", { method: "POST" })
      setToken(fresh.token); setConfirm(false); toast(T("凭证已换发，请保存并更新 Agent")); onSaved()
    } catch (e) { toast(T((e as Error).message), "bad") }
    finally { setBusy(false) }
  }
  return <div className="inspector-form">
    <p className="muted">{T("{name} · 接入标识 node-{id}。在节点运行安装命令并输入原节点令牌；令牌丢失时可换发，新令牌仅本次显示。", { name: node.name, id: node.id })}</p>
    {!allowed && <Notice tone="warn" icon="lock">{!canProvision ? T("请通过 HTTPS 域名访问面板后添加或安装节点。") : T("Hub 尚未配置经过验证的 Agent 本地分发；请先用原生安装器安装当前 romi 发行版，再复制安装命令。")}</Notice>}
    <IntervalField value={interval} onChange={setInterval} />
    <div className="field"><span className="field-label">{T("安装命令")}</span><CodeBlock code={allowed && valid ? agentCommand(site, Number(interval)) : ""} disabled={!allowed || !valid} empty={T("请填写有效的上报间隔。")} label={T("复制命令")} /></div>
    {token && <TokenReveal token={token} />}
    <div className="danger-zone"><div><p className="danger-title">{T("换发凭证")}</p><p className="danger-detail">{T("旧凭证立即作废，Agent 掉线，需用新令牌重新启动 Agent。")}</p></div><Button kind="danger-ghost" icon="key-round" onClick={() => setConfirm(true)} disabled={!allowed}>{T("换发")}</Button></div>
    {confirm && <Confirm title={T("给「{name}」换发凭证？", { name: node.name })} detail={T("旧令牌会立即失效，已连接的 Agent 将断开。请在节点更新令牌后重新连接。")} confirmLabel={T("换发凭证")} busy={busy} onClose={() => setConfirm(false)} onConfirm={rotate} />}
  </div>
}

function Overview({ node, beat, onTab }: { node: Node; beat: number; onTab: (tab: InspectTab) => void }) {
  const f = nodeFacts(node), m = f.m, trend = spark(node.id)
  return <div className="inspector-form">
    <div className="vitals vitals-2">
      <VitalTile icon="cpu" label="CPU" value={f.cpu} unit="%" tone={tone(f.cpu)} sub={m ? T("负载 {load}", { load: m.load[0].toFixed(2) }) : T("待上报")} trend={trend} get={p => p.cpu} max={100} beat={beat} color="var(--trend)" />
      <VitalTile icon="arrow-down-up" label={T("网络")} value={m ? <span className="vital-rates"><FlowValue dir="down" value={m.net_rx} /><FlowValue dir="up" value={m.net_tx} /></span> : null} sub={T("带宽 {bandwidth}", { bandwidth: bandwidth(node.bandwidth_down) })} trend={trend} get={p => p.rx} beat={beat} color="var(--flow-down)" />
    </div>
    <MeterRow label={T("内存")} pct={f.mem} detail={m ? pair(m.mem_used, m.mem_total) : "—"} />
    <MeterRow label={T("磁盘")} pct={f.disk} detail={m ? pair(m.disk_used, m.disk_total) : "—"} />
    <QuotaBar node={node} />
    <dl className="facts facts-2"><Fact label="IPv4"><CopyValue value={node.ipv4} label=" IPv4" /></Fact><Fact label="IPv6"><CopyValue value={node.ipv6} label=" IPv6" /></Fact>
      <Fact label={T("接入标识")}><CopyValue value={"node-" + node.id} label={T("接入标识")} /></Fact><Fact label={T("Agent 版本")} mono>{node.agent_version || T("未上报")}</Fact>
      <Fact label={T("连续在线")}>{continuousUptime(node)}</Fact><Fact label={T("最后上报")}>{node.last_seen ? full(node.last_seen * 1000) : T("尚未接入")}</Fact>
      <Fact label={T("账单")}>{price(node)}</Fact><Fact label={T("到期")}>{expiry(node).text}</Fact></dl>
    <div className="quick-actions"><Button icon="pencil" onClick={() => onTab("settings")}>{T("编辑设置")}</Button><Button icon="wallet" onClick={() => onTab("billing")}>{T("账单与流量")}</Button><Button icon="square-terminal" onClick={() => onTab("install")}>{T("安装 Agent")}</Button></div>
  </div>
}

export function NodeInspector({ node, beat, initialTab = "overview", onClose, onOpen, onSaved, onDeleted, ...access }: {
  node: Node; beat: number; initialTab?: InspectTab; onClose: () => void; onOpen: (node: Node) => void; onSaved: () => void; onDeleted: () => void
  site: string; canProvision: boolean; distributionAvailable: boolean
}) {
  const [tab, setTab] = useState<InspectTab>(initialTab)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const removed = useRef(false)
  function changeTab(next: InspectTab) { panel.current?.closest(".dialog-body")?.scrollTo(0, 0); setTab(next) }
  async function remove() {
    if (busy) return
    setBusy(true)
    try { await api("/nodes/" + node.id, { method: "DELETE" }); removed.current = true; setDeleting(false); toast(T("已删除")); onDeleted() }
    catch (e) { toast(T((e as Error).message), "bad") }
    finally { setBusy(false) }
  }
  return <Dialog kind="sheet" className="inspector" onClose={onClose} focusPanel onCloseAutoFocus={event => {
    if (removed.current) { event.preventDefault(); requestAnimationFrame(() => document.getElementById("main")?.focus()) }
  }}
    head={<div className="inspector-head"><div className="inspector-where"><Region code={node.country} full />{!node.public && <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>}</div>
      <DialogTitle>{node.name}</DialogTitle><div className="inspector-line"><StatusBadge node={node} beat={beat} /><span className="muted">{systemLine(node)}</span></div>
      <a className="link-button inspector-open" href={"/admin/node/" + node.id} onClick={e => { e.preventDefault(); onOpen(node) }}>{T("查看详情与历史")} <Icon name="arrow-up-right" size={14} /></a></div>}
    bar={<Tabs label={T("节点管理")} idPrefix="inspect" value={tab} onChange={changeTab} tabs={[
      { value: "overview", label: T("概览") }, { value: "settings", label: T("设置") }, { value: "billing", label: T("账单与流量") }, { value: "install", label: T("安装") },
    ]} />}>
    <div ref={panel} role="tabpanel" id={"inspect-panel-" + tab} aria-labelledby={"inspect-" + tab} className="inspector-panel">
      {tab === "overview" && <Overview node={node} beat={beat} onTab={changeTab} />}
      {tab === "settings" && <SettingsForm node={node} onSaved={onSaved} onDelete={() => setDeleting(true)} />}
      {tab === "billing" && <BillingForm node={node} onSaved={onSaved} />}
      {tab === "install" && <InstallPanel node={node} onSaved={onSaved} {...access} />}
    </div>
    {deleting && <Confirm title={T("删除节点「{name}」？", { name: node.name })} detail={T("历史指标、流量记录和凭证一并删除，不可恢复。")} confirmLabel={T("删除节点")} busy={busy} onClose={() => setDeleting(false)} onConfirm={remove} />}
  </Dialog>
}

export function CreateNode({ nodes, beat, site, canProvision, distributionAvailable, onClose, onOpen, onSaved }: {
  nodes: Node[]; beat: number; site: string; canProvision: boolean; distributionAvailable: boolean
  onClose: () => void; onOpen: (node: Node) => void; onSaved: () => void
}) {
  const [name, setName] = useState("")
  const [issued, setIssued] = useState<IssuedNode | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [interval, setInterval] = useState("3")
  const live = nodes.find(node => node.id === issued?.id)
  const step = issued ? live?.last_seen || (live?.online && live.metrics) ? 2 : 1 : 0
  const valid = !numericError(interval, { min: 3, max: 60, required: true })
  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError(T("请填写节点名称"))
    if (!canProvision || busy) return
    setBusy(true); setError("")
    try {
      const fresh = await api<{ id: number; token: string }>("/nodes", { method: "POST", body: JSON.stringify({ name: name.trim() }) })
      setIssued({ ...fresh, name: name.trim() }); toast(T("节点已添加")); onSaved()
    } catch (e) { setError(T((e as Error).message)) }
    finally { setBusy(false) }
  }
  return <Dialog title={step === 0 ? T("添加节点") : step === 1 ? T("安装 Agent") : T("{name} 已上线", { name: issued?.name || "" })}
    subtitle={step === 1 && issued ? T("{name} · 接入标识 node-{id}", { name: issued.name, id: issued.id }) : undefined} onClose={onClose} className="add-flow"
    footer={step === 0 ? <><Button onClick={onClose}>{T("取消")}</Button><Button kind="primary" type="submit" form="add-node-form" busy={busy} disabled={!canProvision}>{T("添加")}</Button></> :
      step === 1 ? <><span className="foot-note">{T("关闭后可在节点的「安装」中重新获取命令")}</span><Button onClick={onClose}>{T("稍后安装")}</Button></> :
      <><Button onClick={onClose}>{T("完成")}</Button><Button kind="primary" iconAfter="arrow-up-right" onClick={() => { onClose(); if (live) onOpen(live) }}>{T("查看节点")}</Button></>}>
    <ol className="steps" aria-label={T("步骤")}>{[T("名称"), T("安装"), T("上线")].map((label, i) => <li key={label} data-state={i < step ? "done" : i === step ? "current" : "todo"} aria-current={i === step ? "step" : undefined}><span className="step-mark">{i < step ? <Icon name="check" size={12} /> : i + 1}</span><span>{label}</span></li>)}</ol>
    {step === 0 && <form id="add-node-form" onSubmit={create} className="inspector-form"><Field label={T("名称")} error={error}><Input data-autofocus value={name} maxLength={128} placeholder={T("香港 · 甲商家")} onChange={e => { setName(e.target.value); setError("") }} /></Field></form>}
    {step === 1 && issued && <div className="inspector-form"><TokenReveal token={issued.token} /><IntervalField value={interval} onChange={setInterval} />
      {!distributionAvailable && <Notice tone="warn">{T("Hub 尚未配置经过验证的 Agent 本地分发；请先用原生安装器安装当前 romi 发行版，再复制安装命令。")}</Notice>}
      <div className="field"><span className="field-label">{T("安装命令")}</span><CodeBlock code={valid && distributionAvailable ? agentCommand(site, Number(interval)) : ""} disabled={!valid || !distributionAvailable} empty={T("请填写有效的上报间隔。")} label={T("复制命令")} /></div>
      <div className="waiting" role="status"><span className="radar" aria-hidden="true"><i /><i /><i /></span><div><p className="waiting-title">{T("等待 Agent 首次上报")}</p><p className="waiting-detail">{T("在节点上运行命令并输入令牌，上线后这里会自动更新。")}</p></div></div></div>}
    {step === 2 && live && <div className="joined"><div className="joined-card"><div className="joined-head"><StatusBadge node={live} beat={beat} /><Region code={live.country} full /></div>
      <p className="joined-meta">{systemLine(live)} · Agent {live.agent_version}</p><MeterRow label="CPU" pct={nodeFacts(live).cpu} detail={live.cpu_name} />
      <MeterRow label={T("内存")} pct={nodeFacts(live).mem} detail={live.metrics ? pair(live.metrics.mem_used, live.metrics.mem_total) : "—"} />
      <dl className="facts facts-2"><Fact label="IPv4"><CopyValue value={live.ipv4} label=" IPv4" /></Fact><Fact label={T("首次上报")}>{live.online_since ? full(live.online_since * 1000) : full(live.last_seen * 1000)}</Fact></dl></div></div>}
  </Dialog>
}

export function useRegisterWindow(enabled = true) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    api<Settings>("/settings", { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setSettings(value); setNow(Date.now() / 1000); setError("") } })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(T(e.message || "网络错误")) })
    return () => controller.abort()
  }, [enabled, reload])
  const key = enabled ? String(settings?.register_key ?? "") : ""
  const until = enabled ? Number(settings?.register_until ?? 0) : 0
  useEffect(() => {
    if (!enabled || !key || until <= Date.now() / 1000) return
    const timer = window.setInterval(() => {
      const stamp = Date.now() / 1000
      setNow(stamp)
      if (stamp >= until) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [enabled, key, until])
  const left = key ? Math.max(0, Math.ceil(until - now)) : 0
  async function open() {
    if (!enabled || busy) return
    setBusy(true); setError("")
    try {
      const window = await api<{ register_key: string; register_until: string; register_since_id: string }>("/register-window", { method: "POST" })
      setSettings(old => ({ ...old, ...window })); setNow(Date.now() / 1000); toast(T("注册窗口已开启"))
    } catch (e) { setError(T((e as Error).message)) }
    finally { setBusy(false) }
  }
  async function close() {
    if (!enabled || busy) return
    setBusy(true); setError("")
    try { await api("/register-window", { method: "DELETE" }); setSettings(old => ({ ...old, register_key: "", register_until: "0" })); toast(T("注册窗口已关闭")) }
    catch (e) { setError(T((e as Error).message)) }
    finally { setBusy(false) }
  }
  return { settings: enabled ? settings : null, key, until, left, busy, error: enabled ? error : "", open, close, retry: () => setReload(n => n + 1) }
}

export function RegisterDialog({ site, reg, nodes, beat, canProvision, distributionAvailable, onClose }: {
  site: string; reg: ReturnType<typeof useRegisterWindow>; nodes: Node[]; beat: number; canProvision: boolean; distributionAvailable: boolean; onClose: () => void
}) {
  const command = reg.left > 0 && canProvision && distributionAvailable ? registrationCommand(site, reg.key) : ""
  const clock = Math.floor(reg.left / 60) + ":" + String(reg.left % 60).padStart(2, "0")
  const joined = reg.left > 0 ? nodes.filter(node => (node.created_at ?? 0) > reg.until - 3600 ||
    (node.created_at === reg.until - 3600 && node.id > Number(reg.settings?.register_since_id ?? 0))) : []
  return <Dialog title={T("批量注册")} onClose={onClose} footer={<><Button onClick={onClose}>{T("关闭")}</Button>{command && <Button kind="primary" icon="copy" onClick={() => navigator.clipboard.writeText(command).then(() => toast(T("已复制")), () => toast(T("无法访问剪贴板，请手动选择并复制"), "bad"))}>{T("复制命令")}</Button>}</>}>
    <p className="muted">{T("在节点上运行以下命令：脚本从本 Hub 下载与当前发行版精确匹配的 Agent，校验哈希后安装系统服务（systemd 或 OpenRC）。新节点默认公开；命令包含短期注册密钥，每台机器会换取自己的长期令牌。")}</p>
    {reg.error && <Notice tone="bad" action={<Button onClick={reg.retry} size="sm">{T("重试")}</Button>}>{reg.error}</Notice>}
    {!canProvision || !distributionAvailable ? <Notice tone="warn" icon="lock">{!canProvision ? T("请通过 HTTPS 域名访问面板后添加或安装节点。") : T("Hub 尚未配置经过验证的 Agent 本地分发；请先用原生安装器安装当前 romi 发行版，再复制安装命令。")}</Notice> :
      reg.left > 0 ? <><div className="window-state"><Ring value={reg.left} max={3600} size={52} stroke={4}><Icon name="timer" size={16} /></Ring><div><p className="window-title num">{T("窗口 {clock} 后自动关闭", { clock })}</p><p className="muted small">{T("到点自动失效，装完了也可以现在就关")}</p></div><Button size="sm" busy={reg.busy} onClick={reg.close}>{T("立即关闭")}</Button></div>
        <div className="field"><span className="field-label">{T("安装命令")}</span><CodeBlock code={command} label={T("复制")} /></div>
        <div className="registered"><p className="field-label">{T("本次已注册")} <span className="num">{joined.length}</span></p>{!joined.length ? <p className="registered-empty"><span className="radar radar-sm" aria-hidden="true"><i /><i /></span>{T("等待节点注册")}</p> :
          <ul className="registered-list">{joined.map(node => <li key={node.id}><StatusBadge node={node} beat={beat} compact /><span className="registered-name">{node.name}</span><span className="muted small">{systemLine(node)}</span></li>)}</ul>}</div></> :
      <div className="window-closed"><Button kind="primary" icon="play" busy={reg.busy} onClick={reg.open}>{T("开启一小时窗口")}</Button></div>}
  </Dialog>
}
