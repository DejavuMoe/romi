// The panel's node section: what needs a look, the management list, the
// inspector for one node, and the two ways to bring machines in.

const HUB = "https://hub.example.invalid"
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const canProvision = () => scenario !== "no-dist"
const agentCommand = (seconds) =>
  `tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellQuote(HUB + "/install.sh")} -o "$tmp" && sudo sh "$tmp" --server ${shellQuote(HUB)} --interval ${seconds}`
const registrationCommand = (key) =>
  `tmp=$(mktemp) && trap 'rm -f "$tmp"' EXIT && curl -fsSL ${shellQuote(HUB + "/install.sh")} -o "$tmp" && sudo sh "$tmp" --server ${shellQuote(HUB)} --register-key ${shellQuote(key)}`
const GB = 1024 ** 3
const gb = (bytes) => (bytes ? String(+(bytes / GB).toFixed(3)) : "0")

// What deserves a look now, per node, worst first.
function attention(nodes, settings) {
  const traffic = Number(settings.notify_traffic) || 0
  const expiry = Number(settings.notify_expiry) || 0
  const out = []
  for (const n of nodes) {
    const f = nodeFacts(n)
    const reasons = []
    const gap = Math.max(0, Date.now() / 1000 - n.last_seen)
    if (f.status === "offline") reasons.push({ tone: "bad", icon: "wifi-off", text: T("离线 {time}", { time: gap < 60 ? T("{m} 分", { m: 1 }) : fmt.uptime(gap) }) })
    if (f.status === "reconnecting") reasons.push({ tone: "warn", icon: "loader-circle", text: T("重连中") })
    if (f.status === "never") reasons.push({ tone: "info", icon: "clock", text: T("尚未接入") })
    if (f.m) {
      if (f.cpu >= 85) reasons.push({ tone: "bad", icon: "cpu", text: `CPU ${f.cpu.toFixed(0)}%` })
      if (f.mem >= 85) reasons.push({ tone: "bad", icon: "memory-stick", text: T("内存 {pct}%", { pct: f.mem.toFixed(0) }) })
      if (f.disk >= 85) reasons.push({ tone: "bad", icon: "hard-drive", text: T("磁盘 {pct}%", { pct: f.disk.toFixed(0) }) })
    }
    const exp = fmt.expiry(n)
    if (exp.days != null && exp.days < 0) reasons.push({ tone: "bad", icon: "calendar", text: exp.text })
    else if (exp.days != null && expiry && exp.days <= expiry) reasons.push({ tone: "warn", icon: "calendar", text: exp.text })
    if (n.traffic_limit > 0 && traffic) {
      const pct = (fmt.monthUsage(n) / n.traffic_limit) * 100
      if (pct >= 100) reasons.push({ tone: "bad", icon: "arrow-down-up", text: T("本期流量已用尽") })
      else if (pct >= traffic) reasons.push({ tone: "warn", icon: "arrow-down-up", text: T("本期流量 {pct}%", { pct: pct.toFixed(0) }) })
    }
    if (reasons.length) out.push({ node: n, reasons, rank: reasons.some((r) => r.tone === "bad") ? 0 : reasons.some((r) => r.tone === "warn") ? 1 : 2 })
  }
  // Most severe first, then in list order. A reason coming or going within the
  // same severity never reorders the cards.
  return out.sort((a, b) => a.rank - b.rank || nodes.indexOf(a.node) - nodes.indexOf(b.node))
}

// As many columns as fit at 200px, then fewer so the rows come out even: five
// cards sit in one row, six in two rows of three, never four and one.
function AttentionBand({ items, onInspect }) {
  const list = useRef(null)
  const width = useWidth(list)
  const fit = Math.max(1, Math.floor((width + 10) / 210))
  const cols = Math.ceil(items.length / Math.ceil(items.length / fit))
  if (!items.length)
    return (
      <div className="attention attention-clear">
        <Icon name="circle-check" size={16} />
        <span>{T("所有节点运行正常")}</span>
      </div>
    )
  return (
    <section className="attention" aria-labelledby="attention-title">
      <div className="attention-head">
        <h2 id="attention-title">{T("需要关注")}</h2>
        <span className="fleet-count num">{items.length}</span>
      </div>
      <div ref={list} className="attention-list" style={{ "--cols": cols }}>
        {items.map(({ node, reasons }) => (
          <button type="button" key={node.id} className="attention-card" data-tone={reasons[0].tone} onClick={() => onInspect(node)}>
            <span className="attention-name">
              <StatusDot status={fmt.connection(node)} />
              <span>{node.name}</span>
            </span>
            <span className="attention-reasons">
              {reasons.map((r, i) => (
                <span key={i} className="tag" data-tone={r.tone === "info" ? undefined : r.tone}>
                  <Icon name={r.icon} size={12} />
                  {r.text}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function LoadCell({ node }) {
  const f = nodeFacts(node)
  const rows = [["CPU", f.cpu], [T("内存"), f.mem], [T("磁盘"), f.disk]]
  return (
    <span className="load-cell">
      {rows.map(([label, v]) => (
        <span key={label} className="load-row" data-tone={fmt.tone(v)}>
          <span className="load-label">{label}</span>
          <Meter value={v} thin />
          <b className="num">{v == null ? "—" : `${Math.round(v)}%`}</b>
        </span>
      ))}
    </span>
  )
}

function NodesTable({ nodes, beat, onInspect, onOpen }) {
  return (
    <div className="table-card">
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">{T("节点")}</th>
            <th scope="col">{T("地址")}</th>
            <th scope="col">{T("负载")}</th>
            <th scope="col">{T("网络")}</th>
            <th scope="col">{T("Agent 版本")}</th>
            <th scope="col">{T("接入标识")}</th>
            <th scope="col" className="num-col">{T("优先级")}</th>
            <th scope="col"><span className="sr-only">{T("操作")}</span></th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const f = nodeFacts(n)
            return (
              <tr key={n.id} data-status={f.status} onClick={(e) => { if (!e.target.closest("a,button")) onInspect(n) }}>
                <th scope="row" className="at-node">
                  <span className="at-name">
                    <StatusDot status={f.status} beat={beat} />
                    <a href={`#/node/${n.id}`} onClick={(e) => openNode(e, n, onOpen)}>{n.name}</a>
                  </span>
                  <span className="at-tags">
                    <Region code={n.country} />
                    <span className={`status-text`} data-status={f.status}>{fmt.CONNECTION[f.status]}</span>
                    {!n.public && <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>}
                    {!n.notify && <span className="tag"><Icon name="bell" size={12} />{T("通知关闭")}</span>}
                  </span>
                  {n.remark && <span className="at-remark">{n.remark}</span>}
                </th>
                <td className="at-addr">
                  <span className="addr-line"><span className="addr-kind">IPv4</span><CopyValue value={n.ipv4} label={`${n.name} IPv4`} /></span>
                  <span className="addr-line"><span className="addr-kind">IPv6</span><CopyValue value={n.ipv6} label={`${n.name} IPv6`} /></span>
                </td>
                <td><LoadCell node={n} /></td>
                <td className="at-net num">
                  <span className="at-net-rates">
                    <FlowValue dir="down" value={f.m ? f.m.net_rx : null} />
                    <FlowValue dir="up" value={f.m ? f.m.net_tx : null} />
                  </span>
                </td>
                <td className="mono">{n.agent_version || <span className="muted">{T("未上报")}</span>}</td>
                <td><CopyValue value={`node-${n.id}`} label={T("{name} 接入标识", { name: n.name })} /></td>
                <td className="num num-col">{n.priority}</td>
                <td className="at-actions">
                  <Button size="sm" icon="sliders-horizontal" onClick={() => onInspect(n)} aria-label={T("管理 {name}", { name: n.name })}>{T("管理")}</Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function NodesPage({ nodes, beat, settings, onInspect, onOpen, onAdd, onRegister, state, onRetry, connected }) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  // The time of the last push, which stops when the connection drops.
  const updated = useMemo(() => Date.now(), [beat])
  const q = query.trim().toLowerCase()
  const shown = nodes.filter(
    (n) =>
      [n.name, String(n.id), `node-${n.id}`, n.ipv4, n.ipv6, n.remark].some((v) => String(v || "").toLowerCase().includes(q)) &&
      (filter === "all" || (filter === "online" ? n.online : !n.online)),
  )
  const online = nodes.filter((n) => n.online).length
  if (state === "loading")
    return (
      <div className="stack-page" role="status" aria-label={T("正在加载节点")}>
        <div className="skeleton" style={{ height: 84 }}></div>
        <div className="skeleton" style={{ height: 420 }}></div>
      </div>
    )
  if (state === "error") return <Empty error title={T("节点加载失败")} detail={T("请求失败，未改变任何数据。")} action={T("重试")} onAction={onRetry} />
  if (!nodes.length)
    return (
      <Empty
        icon="server"
        title={T("还没有节点")}
        detail={T("添加一个节点并在主机上安装 Agent，或开启注册窗口批量接入。")}
        action={T("添加节点")}
        onAction={onAdd}
        secondary={T("批量注册")}
        onSecondary={onRegister}
      />
    )
  return (
    <div className="stack-page">
      <AttentionBand items={attention(nodes, settings)} onInspect={onInspect} />
      <div className="toolbar">
        <label className="search-field search-wide">
          <Icon name="search" />
          <input type="search" aria-label={T("搜索节点")} placeholder={T("搜索名称、IP 或节点标识")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Segmented
          label={T("节点状态筛选")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: T("全部"), count: nodes.length },
            { value: "online", label: T("在线"), count: online },
            { value: "offline", label: T("离线"), count: nodes.length - online },
          ]}
        />
        <div className="toolbar-end">
          <span className="toolbar-meta" data-live={connected}>
            <span className="live-dot"></span>
            {q && <span className="num">{T("{n} 个匹配", { n: shown.length })}</span>}
            <span className="num">{T("更新于 {time}", { time: fmt.clock(updated) })}</span>
          </span>
          <Button icon="ticket" onClick={onRegister}>{T("批量注册")}</Button>
          <Button kind="primary" icon="plus" onClick={onAdd}>{T("添加节点")}</Button>
        </div>
      </div>
      {!canProvision() && <Notice tone="warn" icon="lock">{T("请通过 HTTPS 域名访问面板后添加或安装节点。")}</Notice>}
      {!connected && <Notice tone="warn" icon="wifi-off">{T("实时连接已断开，正在重连。列表停留在最后一次更新。")}</Notice>}
      {!shown.length ? (
        <Empty icon="search" compact title={T("没有匹配的节点")} action={T("清除搜索")} onAction={() => { setQuery(""); setFilter("all") }} />
      ) : (
        <NodesTable nodes={shown} beat={beat} onInspect={onInspect} onOpen={onOpen} />
      )}
    </div>
  )
}

// ---- inspector -------------------------------------------------------------

function useForm(initial) {
  const [values, setValues] = useState(initial)
  const set = (key, value) => setValues((v) => ({ ...v, [key]: value }))
  const dirty = Object.keys(initial).some((k) => JSON.stringify(initial[k]) !== JSON.stringify(values[k]))
  return { values, set, setValues, dirty, reset: () => setValues(initial) }
}

// Mbps stored; typed as Mbps or Gbps.
function BandwidthInput({ label, value, onChange, error }) {
  const [unit, setUnit] = useState(value >= 1000 && value % 1000 === 0 ? "Gbps" : "Mbps")
  const [text, setText] = useState(String(unit === "Gbps" ? value / 1000 : value))
  const msg = fmt.numericError(text, { min: 0, max: unit === "Gbps" ? 1000 : 1000000, step: "any", required: true })
  useEffect(() => onChange(msg ? NaN : Number(text) * (unit === "Gbps" ? 1000 : 1)), [text, unit])
  return (
    <Field label={label} hint={T("0 表示未设置")} error={msg || error}>
      <span className="input-group">
        <input className="input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="input-unit" aria-label={T("{label}单位", { label })} value={unit} onChange={(e) => { const u = e.target.value; if (!msg) setText(String(+(Number(text) * (u === "Gbps" ? 0.001 : 1000)).toFixed(3))); setUnit(u) }}>
          <option>Mbps</option>
          <option>Gbps</option>
        </select>
      </span>
    </Field>
  )
}

function SettingsForm({ node, onSaved, onDelete }) {
  const initial = useMemo(() => ({
    name: node.name, remark: node.remark || "", priority: String(node.priority ?? 0), public: node.public !== false,
    has_ipv4: !!node.has_ipv4, has_ipv6: !!node.has_ipv6, bandwidth_down: node.bandwidth_down || 0, bandwidth_up: node.bandwidth_up || 0,
    same: (node.bandwidth_down || 0) === (node.bandwidth_up || 0), notify: !!node.notify,
  }), [node.id])
  const form = useForm(initial)
  const v = form.values
  const [busy, setBusy] = useState(false)
  const errors = {
    name: v.name.trim() ? "" : T("请填写节点名称"),
    priority: fmt.numericError(v.priority, { min: 0, max: 999999, required: true }),
  }
  const invalid = Object.values(errors).some(Boolean) || Number.isNaN(v.bandwidth_down) || (!v.same && Number.isNaN(v.bandwidth_up))
  const save = (e) => {
    e.preventDefault()
    if (invalid) return
    setBusy(true)
    setTimeout(() => {
      window.romiSim.update(node.id, {
        name: v.name.trim(), remark: v.remark, priority: Number(v.priority), public: v.public, has_ipv4: v.has_ipv4, has_ipv6: v.has_ipv6,
        bandwidth_down: v.bandwidth_down, bandwidth_up: v.same ? v.bandwidth_down : v.bandwidth_up, notify: v.notify,
      })
      setBusy(false)
      onSaved(T("节点已保存"))
    }, 500)
  }
  return (
    <form className="inspector-form" onSubmit={save} noValidate>
      <Field label={T("名称")} error={errors.name}><Input value={v.name} maxLength={128} onChange={(e) => form.set("name", e.target.value)} /></Field>
      <Field label={T("备注")} hint={T("仅管理员可见")} optional><Input value={v.remark} placeholder={T("商家、用途")} onChange={(e) => form.set("remark", e.target.value)} /></Field>
      <div className="form-grid">
        <Field label={T("展示优先级")} hint={T("0–999999 整数，数字越大越靠前")} error={errors.priority}><Input inputMode="numeric" value={v.priority} onChange={(e) => form.set("priority", e.target.value)} /></Field>
        <div className="field">
          <span className="field-label">{T("公开状态页")}</span>
          <Segmented label={T("公开状态页")} value={v.public ? "public" : "private"} onChange={(x) => form.set("public", x === "public")} options={[{ value: "public", label: T("显示") }, { value: "private", label: T("不显示") }]} />
          <p className="field-message"><span>{T("私有节点只在管理列表显示。")}</span></p>
        </div>
      </div>
      <fieldset className="form-set">
        <legend>{T("网络")}</legend>
        <div className="form-grid">
          <div className="field">
            <span className="field-label">IPv4</span>
            <Segmented label="IPv4" value={v.has_ipv4 ? "yes" : "no"} onChange={(x) => form.set("has_ipv4", x === "yes")} options={[{ value: "yes", label: T("有") }, { value: "no", label: T("无") }]} />
          </div>
          <div className="field">
            <span className="field-label">IPv6</span>
            <Segmented label="IPv6" value={v.has_ipv6 ? "yes" : "no"} onChange={(x) => form.set("has_ipv6", x === "yes")} options={[{ value: "yes", label: T("有") }, { value: "no", label: T("无") }]} />
          </div>
        </div>
        <div className="form-grid">
          <BandwidthInput label={v.same ? T("可用带宽") : T("下载带宽")} value={initial.bandwidth_down} onChange={(x) => form.set("bandwidth_down", x)} />
          {!v.same && <BandwidthInput label={T("上传带宽")} value={initial.bandwidth_up} onChange={(x) => form.set("bandwidth_up", x)} />}
        </div>
        <Check checked={v.same} onChange={(x) => form.set("same", x)}>{T("上传与下载相同")}</Check>
      </fieldset>
      <Switch checked={v.notify} onChange={(x) => form.set("notify", x)} label={T("离线通知")} detail={T("掉线超过宽限期推送一条，恢复在线时再推一条")} />
      <div className="inspector-actions">
        <span className="dirty-note">{form.dirty ? T("有未保存的修改") : ""}</span>
        <Button disabled={!form.dirty || busy} onClick={form.reset}>{T("还原")}</Button>
        <Button kind="primary" type="submit" busy={busy} disabled={!form.dirty || invalid}>{T("保存")}</Button>
      </div>
      <div className="danger-zone">
        <div>
          <p className="danger-title">{T("删除节点")}</p>
          <p className="danger-detail">{T("历史指标、流量记录和凭证一并删除，不可恢复。")}</p>
        </div>
        <Button kind="danger-ghost" icon="trash-2" onClick={onDelete}>{T("删除节点")}</Button>
      </div>
    </form>
  )
}

function BillingForm({ node, onSaved }) {
  const unit0 = node.traffic_unit === "TB" ? "TB" : "GB"
  const initial = useMemo(() => ({
    price: node.price ? String(node.price) : "", currency: node.currency || "USD", billing_cycle: node.billing_cycle || "monthly",
    expires_at: node.expires_at || "", limit: String(+(node.traffic_limit / GB / (unit0 === "TB" ? 1024 : 1)).toFixed(3)), unit: unit0,
    traffic_mode: node.traffic_mode || "sum", reset: String(node.traffic_reset_day || 1),
    total_rx: gb(node.total_rx), total_tx: gb(node.total_tx), month_rx: gb(node.month_rx), month_tx: gb(node.month_tx),
  }), [node.id])
  const form = useForm(initial)
  const v = form.values
  const [busy, setBusy] = useState(false)
  const errors = {
    price: fmt.numericError(v.price, { min: 0, max: 1000000, step: "any" }),
    expires_at: fmt.dateError(v.expires_at),
    limit: fmt.numericError(v.limit, { min: 0, step: "any", required: true }),
    reset: fmt.numericError(v.reset, { min: 1, max: 31, required: true }),
    total_rx: fmt.numericError(v.total_rx, { step: "any" }), total_tx: fmt.numericError(v.total_tx, { step: "any" }),
    month_rx: fmt.numericError(v.month_rx, { step: "any" }), month_tx: fmt.numericError(v.month_tx, { step: "any" }),
  }
  const invalid = Object.values(errors).some(Boolean)
  const save = (e) => {
    e.preventDefault()
    if (invalid) return
    setBusy(true)
    setTimeout(() => {
      const patch = {
        price: Number(v.price || 0), currency: v.currency, billing_cycle: v.billing_cycle, expires_at: v.expires_at || null,
        traffic_limit: Number(v.limit) * GB * (v.unit === "TB" ? 1024 : 1), traffic_unit: v.unit, traffic_mode: v.traffic_mode,
        traffic_reset_day: Number(v.reset),
      }
      // Only counters that were edited are corrected; the others keep counting.
      for (const k of ["total_rx", "total_tx", "month_rx", "month_tx"]) if (v[k] !== initial[k]) patch[k] = Number(v[k]) * GB
      window.romiSim.update(node.id, patch)
      setBusy(false)
      onSaved(T("账单与流量已保存"))
    }, 500)
  }
  return (
    <form className="inspector-form" onSubmit={save} noValidate>
      <fieldset className="form-set">
        <legend>{T("账单")}</legend>
        <div className="form-grid">
          <Field label={T("价格")} hint={T("留空或 0 为免费")} error={errors.price}>
            <span className="input-group">
              <input className="input" inputMode="decimal" placeholder={T("免费")} value={v.price} onChange={(e) => form.set("price", e.target.value)} />
              <select className="input-unit" aria-label={T("货币")} value={v.currency} onChange={(e) => form.set("currency", e.target.value)}>
                {["USD", "CNY", "EUR", "GBP", "JPY"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </span>
          </Field>
          <Field label={T("付款周期")}>
            <Select value={v.billing_cycle} onChange={(e) => form.set("billing_cycle", e.target.value)}>
              {Object.entries(fmt.CYCLES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={T("到期时间")} hint={T("YYYY-MM-DD；留空表示永不到期")} error={errors.expires_at}>
          <Input type="date" value={v.expires_at} onChange={(e) => form.set("expires_at", e.target.value)} />
        </Field>
      </fieldset>
      <fieldset className="form-set">
        <legend>{T("流量")}</legend>
        <div className="form-grid">
          <Field label={T("每月流量额度")} hint={T("0 表示不限")} error={errors.limit}>
            <span className="input-group">
              <input className="input" inputMode="decimal" value={v.limit} onChange={(e) => form.set("limit", e.target.value)} />
              <select className="input-unit" aria-label={T("额度单位")} value={v.unit} onChange={(e) => { const u = e.target.value; if (!errors.limit) form.set("limit", String(+(Number(v.limit) * (u === "TB" ? 1 / 1024 : 1024)).toFixed(3))); form.set("unit", u) }}>
                <option>GB</option>
                <option>TB</option>
              </select>
            </span>
          </Field>
          <Field label={T("每月重置日")} hint={T("1–31。本月流量按新周期重算，总流量不变")} error={errors.reset}>
            <Input inputMode="numeric" value={v.reset} onChange={(e) => form.set("reset", e.target.value)} />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">{T("流量计算方式")}</span>
          <Segmented label={T("流量计算方式")} value={v.traffic_mode} onChange={(x) => form.set("traffic_mode", x)} options={Object.entries(fmt.MODES).map(([value, label]) => ({ value, label }))} />
        </div>
        <details className="disclosure">
          <summary><Icon name="chevron-right" size={14} />{T("流量校正")}</summary>
          <p className="muted small">{T("按 GB 填入需要校正的值，未修改的计数器继续正常累计。")}</p>
          <div className="form-grid">
            {[["total_rx", T("累计下行")], ["total_tx", T("累计上行")], ["month_rx", T("本月下行")], ["month_tx", T("本月上行")]].map(([k, label]) => (
              <Field key={k} label={`${label} (GB)`} error={errors[k]}><Input inputMode="decimal" value={v[k]} onChange={(e) => form.set(k, e.target.value)} /></Field>
            ))}
          </div>
        </details>
      </fieldset>
      <div className="inspector-actions">
        <span className="dirty-note">{form.dirty ? T("有未保存的修改") : ""}</span>
        <Button disabled={!form.dirty || busy} onClick={form.reset}>{T("还原")}</Button>
        <Button kind="primary" type="submit" busy={busy} disabled={!form.dirty || invalid}>{T("保存")}</Button>
      </div>
    </form>
  )
}

function TokenReveal({ token }) {
  return (
    <div className="token-reveal">
      <Notice tone="warn" icon="key-round">{T("节点令牌仅本次显示，关闭后无法再次查看。安装时按提示输入。")}</Notice>
      <CodeBlock code={token} label={T("复制令牌")} />
    </div>
  )
}

function IntervalField({ value, onChange }) {
  const error = fmt.numericError(value, { min: 3, max: 60, required: true })
  return (
    <Field label={T("上报间隔（秒）")} hint={T("3–60 秒，整数；默认 3 秒。")} error={error ? T("请输入 3–60 的整数") : ""}>
      <Input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

function InstallPanel({ node, onToast }) {
  const [interval, setInterval_] = useState("3")
  const [token, setToken] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const valid = !fmt.numericError(interval, { min: 3, max: 60, required: true })
  if (!canProvision()) return <Notice tone="warn" icon="lock">{T("请通过 HTTPS 域名访问面板后添加或安装节点。")}</Notice>
  return (
    <div className="inspector-form">
      <p className="muted">{T("{name} · 接入标识 node-{id}。在节点运行安装命令并输入原节点令牌；令牌丢失时可换发，新令牌仅本次显示。", { name: node.name, id: node.id })}</p>
      <IntervalField value={interval} onChange={setInterval_} />
      <div className="field">
        <span className="field-label">{T("安装命令")}</span>
        <CodeBlock code={valid ? agentCommand(Number(interval)) : ""} disabled={!valid} empty={T("请填写有效的上报间隔。")} label={T("复制命令")} />
      </div>
      {token && <TokenReveal token={token} />}
      <div className="danger-zone">
        <div>
          <p className="danger-title">{T("换发凭证")}</p>
          <p className="danger-detail">{T("旧凭证立即作废，Agent 掉线，需用新令牌重新启动 Agent。")}</p>
        </div>
        <Button kind="danger-ghost" icon="key-round" onClick={() => setConfirm(true)}>{T("换发")}</Button>
      </div>
      {confirm && (
        <Confirm
          title={T("给「{name}」换发凭证？", { name: node.name })}
          detail={T("旧令牌会立即失效，已连接的 Agent 将断开。请在节点更新令牌后重新连接。")}
          confirmLabel={T("换发凭证")}
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            setBusy(true)
            setTimeout(() => {
              setBusy(false)
              setConfirm(false)
              setToken(`sample-token-not-valid-${node.id}${Math.random().toString(16).slice(2, 8)}`)
              onToast(T("凭证已换发，请保存并更新 Agent"))
            }, 600)
          }}
        />
      )}
    </div>
  )
}

function Overview({ node, beat, onTab }) {
  const f = nodeFacts(node)
  const m = f.m
  const spark = window.romiSim.spark(node.id)
  return (
    <div className="inspector-form">
      <div className="vitals vitals-2">
        <VitalTile icon="cpu" label="CPU" value={f.cpu} unit="%" tone={fmt.tone(f.cpu)} sub={m ? T("负载 {load}", { load: m.load[0].toFixed(2) }) : T("待上报")} spark={spark} get={(p) => p.cpu} max={100} beat={beat} color="var(--trend)" />
        <VitalTile icon="arrow-down-up" label={T("网络")} value={m ? <span className="vital-rates"><FlowValue dir="down" value={m.net_rx} /><FlowValue dir="up" value={m.net_tx} /></span> : null} sub={T("带宽 {bandwidth}", { bandwidth: fmt.bandwidth(node.bandwidth_down) })} spark={spark} get={(p) => p.rx} beat={beat} color="var(--flow-down)" />
      </div>
      <MeterRow label={T("内存")} pct={f.mem} detail={m ? fmt.pair(m.mem_used, m.mem_total) : "—"} />
      <MeterRow label={T("磁盘")} pct={f.disk} detail={m ? fmt.pair(m.disk_used, m.disk_total) : "—"} />
      <QuotaBar node={node} />
      <dl className="facts facts-2">
        <Fact label="IPv4"><CopyValue value={node.ipv4} label=" IPv4" /></Fact>
        <Fact label="IPv6"><CopyValue value={node.ipv6} label=" IPv6" /></Fact>
        <Fact label={T("接入标识")}><CopyValue value={`node-${node.id}`} label={T("接入标识")} /></Fact>
        <Fact label={T("Agent 版本")} mono>{node.agent_version || T("未上报")}</Fact>
        <Fact label={T("连续在线")}>{fmt.continuousUptime(node)}</Fact>
        <Fact label={T("最后上报")}>{node.last_seen ? fmt.full(node.last_seen * 1000) : T("尚未接入")}</Fact>
        <Fact label={T("账单")}>{fmt.price(node)}</Fact>
        <Fact label={T("到期")}>{fmt.expiry(node).text}</Fact>
      </dl>
      <div className="quick-actions">
        <Button icon="pencil" onClick={() => onTab("settings")}>{T("编辑设置")}</Button>
        <Button icon="wallet" onClick={() => onTab("billing")}>{T("账单与流量")}</Button>
        <Button icon="square-terminal" onClick={() => onTab("install")}>{T("安装 Agent")}</Button>
      </div>
    </div>
  )
}

function NodeInspector({ node, beat, initialTab = "overview", onClose, onOpen, onDeleted }) {
  const [tab, setTab] = useState(initialTab)
  const panel = useRef(null)
  // Each tab opens at its top.
  useLayoutEffect(() => { panel.current?.closest(".dialog-body")?.scrollTo(0, 0) }, [tab])
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const f = nodeFacts(node)
  const head = (
    <div className="inspector-head">
      <div className="inspector-where">
        <Region code={node.country} full />
        {!node.public && <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>}
      </div>
      <h2 id="inspector-title">{node.name}</h2>
      <div className="inspector-line">
        <StatusBadge node={node} beat={beat} />
        <span className="muted">{systemLine(node)}</span>
      </div>
      <a className="link-button inspector-open" href={`#/node/${node.id}`} onClick={(e) => { e.preventDefault(); onClose(); onOpen(node) }}>
        {T("查看详情与历史")} <Icon name="arrow-up-right" size={14} />
      </a>
    </div>
  )
  return (
    <Dialog
      kind="sheet"
      onClose={onClose}
      head={head}
      bar={
        <Tabs
          label={T("节点管理")}
          idPrefix="inspect"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "overview", label: T("概览") },
            { value: "settings", label: T("设置") },
            { value: "billing", label: T("账单与流量") },
            { value: "install", label: T("安装") },
          ]}
        />
      }
      labelledBy="inspector-title"
      className="inspector"
      focusPanel
    >
      <div ref={panel} role="tabpanel" id={`inspect-panel-${tab}`} aria-labelledby={`inspect-${tab}`} className="inspector-panel">
        {tab === "overview" && <Overview node={node} beat={beat} onTab={setTab} />}
        {tab === "settings" && <SettingsForm node={node} onSaved={(t) => toast(t)} onDelete={() => setDeleting(true)} />}
        {tab === "billing" && <BillingForm node={node} onSaved={(t) => toast(t)} />}
        {tab === "install" && <InstallPanel node={node} onToast={(t) => toast(t)} />}
      </div>
      {deleting && (
        <Confirm
          title={T("删除节点「{name}」？", { name: node.name })}
          detail={T("历史指标、流量记录和凭证一并删除，不可恢复。")}
          confirmLabel={T("删除节点")}
          busy={busy}
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setBusy(true)
            setTimeout(() => {
              window.romiSim.remove(node.id)
              setDeleting(false)
              onDeleted(node)
            }, 500)
          }}
        />
      )}
    </Dialog>
  )
}

// ---- bringing machines in ------------------------------------------------------

function Steps({ at, steps }) {
  return (
    <ol className="steps" aria-label={T("步骤")}>
      {steps.map((s, i) => (
        <li key={s} data-state={i < at ? "done" : i === at ? "current" : "todo"} aria-current={i === at ? "step" : undefined}>
          <span className="step-mark">{i < at ? <Icon name="check" size={12} /> : i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  )
}

// Name → token and command → the first report arriving, watched live.
function AddNodeFlow({ onClose, onOpen, beat }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [node, setNode] = useState(null)
  const [interval, setInterval_] = useState("3")
  const [token] = useState(() => `sample-token-not-valid-${Math.random().toString(16).slice(2, 10)}`)
  const valid = !fmt.numericError(interval, { min: 3, max: 60, required: true })
  const live = node && window.romiSim.nodes().find((n) => n.id === node.id)
  const joined = live && live.online
  // Stand-in for the Agent on the other machine: it reports a little after
  // the command is copied, or after a while regardless.
  const armed = useRef(false)
  const arm = (delay) => {
    if (armed.current || !node) return
    armed.current = true
    setTimeout(() => window.romiSim.connect(node.id), delay)
  }
  useEffect(() => {
    if (step === 1 && node) {
      const t = setTimeout(() => arm(0), 16000)
      return () => clearTimeout(t)
    }
  }, [step, node])
  useEffect(() => {
    if (joined && step === 1) setStep(2)
  }, [joined])
  const create = (e) => {
    e.preventDefault()
    if (!name.trim()) return setError(T("请填写节点名称"))
    setBusy(true)
    setTimeout(() => {
      setBusy(false)
      setNode(window.romiSim.addNode(name.trim()))
      setStep(1)
      toast(T("节点已添加"))
    }, 550)
  }
  const title = step === 0 ? T("添加节点") : step === 1 ? T("安装 Agent") : T("{name} 已上线", { name: live.name })
  return (
    <Dialog
      title={title}
      subtitle={step === 1 ? T("{name} · 接入标识 node-{id}", { name: node.name, id: node.id }) : undefined}
      onClose={onClose}
      size="md"
      className="add-flow"
      footer={
        step === 0 ? (
          <>
            <Button onClick={onClose}>{T("取消")}</Button>
            <Button kind="primary" type="submit" form="add-node-form" busy={busy} disabled={!canProvision()}>{T("添加")}</Button>
          </>
        ) : step === 1 ? (
          <>
            <span className="foot-note">{T("关闭后可在节点的「安装」中重新获取命令")}</span>
            <Button onClick={onClose}>{T("稍后安装")}</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{T("完成")}</Button>
            <Button kind="primary" iconAfter="arrow-up-right" onClick={() => { onClose(); onOpen(live) }}>{T("查看节点")}</Button>
          </>
        )
      }
    >
      <Steps at={step} steps={[T("名称"), T("安装"), T("上线")]} />
      {step === 0 && (
        <form id="add-node-form" onSubmit={create} className="inspector-form">
          {!canProvision() && <Notice tone="warn" icon="lock">{T("请通过 HTTPS 域名访问面板后添加或安装节点。")}</Notice>}
          <Field label={T("名称")} error={error}>
            <Input data-autofocus value={name} maxLength={128} placeholder={T("香港 · 甲商家")} onChange={(e) => { setName(e.target.value); setError("") }} />
          </Field>
        </form>
      )}
      {step === 1 && (
        <div className="inspector-form">
          <TokenReveal token={token} />
          <IntervalField value={interval} onChange={setInterval_} />
          <div className="field" onClickCapture={(e) => { if (e.target.closest("button")) arm(5200) }}>
            <span className="field-label">{T("安装命令")}</span>
            <CodeBlock code={valid ? agentCommand(Number(interval)) : ""} disabled={!valid} empty={T("请填写有效的上报间隔。")} label={T("复制命令")} />
          </div>
          <div className="waiting" role="status">
            <span className="radar" aria-hidden="true"><i></i><i></i><i></i></span>
            <div>
              <p className="waiting-title">{T("等待 Agent 首次上报")}</p>
              <p className="waiting-detail">{T("在节点上运行命令并输入令牌，上线后这里会自动更新。")}</p>
            </div>
          </div>
        </div>
      )}
      {step === 2 && live && (
        <div className="joined">
          <div className="joined-burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ "--k": i }}></i>)}</div>
          <div className="joined-card">
            <div className="joined-head">
              <StatusBadge node={live} beat={beat} />
              <Region code={live.country} full />
            </div>
            <p className="joined-meta">{systemLine(live)} · Agent {live.agent_version}</p>
            <MeterRow label="CPU" pct={nodeFacts(live).cpu} detail={live.cpu_name} />
            <MeterRow label={T("内存")} pct={nodeFacts(live).mem} detail={fmt.pair(live.metrics.mem_used, live.metrics.mem_total)} />
            <dl className="facts facts-2">
              <Fact label="IPv4"><CopyValue value={live.ipv4} label=" IPv4" /></Fact>
              <Fact label={T("首次上报")}>{fmt.clock(live.online_since * 1000)}</Fact>
            </dl>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function RegisterDialog({ reg, onClose, nodes, beat }) {
  const now = useNow(1000)
  const left = reg.until ? Math.max(0, Math.round((reg.until - now) / 1000)) : 0
  const open = left > 0
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
  const joined = open ? nodes.filter((n) => n.id > reg.sinceId) : []
  return (
    <Dialog
      title={T("批量注册")}
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{T("关闭")}</Button>
          {open && <Button kind="primary" icon="copy" onClick={() => copyText(registrationCommand(reg.key))}>{T("复制命令")}</Button>}
        </>
      }
    >
      <p className="muted">
        {T("在节点上运行以下命令：脚本从本 Hub 下载与当前发行版精确匹配的 Agent，校验哈希后安装系统服务（systemd 或 OpenRC）。新节点默认公开；命令包含短期注册密钥，每台机器会换取自己的长期令牌。")}
      </p>
      {!canProvision() ? (
        <Notice tone="warn" icon="lock">{T("请通过 HTTPS 域名访问面板后添加或安装节点。")}</Notice>
      ) : open ? (
        <>
          <div className="window-state">
            <Ring value={left} max={3600} size={52} stroke={4} tone="accent"><Icon name="timer" size={16} /></Ring>
            <div>
              <p className="window-title num">{T("窗口 {clock} 后自动关闭", { clock })}</p>
              <p className="muted small">{T("到点自动失效，装完了也可以现在就关")}</p>
            </div>
            <Button size="sm" onClick={reg.close}>{T("立即关闭")}</Button>
          </div>
          <div className="field">
            <span className="field-label">{T("安装命令")}</span>
            <CodeBlock code={registrationCommand(reg.key)} label={T("复制")} />
          </div>
          <div className="registered">
            <p className="field-label">{T("本次已注册")} <span className="num">{joined.length}</span></p>
            {!joined.length ? (
              <p className="registered-empty"><span className="radar radar-sm" aria-hidden="true"><i></i><i></i></span>{T("等待节点注册")}</p>
            ) : (
              <ul className="registered-list">
                {joined.map((n) => (
                  <li key={n.id}>
                    <StatusBadge node={n} beat={beat} compact />
                    <span className="registered-name">{n.name}</span>
                    <span className="muted small">{systemLine(n)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="window-closed">
          <Button kind="primary" icon="play" onClick={reg.open}>{T("开启一小时窗口")}</Button>
        </div>
      )}
    </Dialog>
  )
}

// The registration window lives on the hub; the panel reads it and counts down.
function useRegisterWindow() {
  const [state, setState] = useState({ key: "", until: 0, sinceId: 0 })
  const timers = useRef([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  return {
    ...state,
    open() {
      const sinceId = Math.max(0, ...window.romiSim.nodes().map((n) => n.id))
      setState({ key: "sample-register-key-not-valid", until: Date.now() + 3600 * 1000, sinceId })
      toast(T("注册窗口已开启"))
      // Stand-in for a machine running the command during the window.
      timers.current.push(setTimeout(() => {
        const n = window.romiSim.addNode(T("注册 · reg-{n}", { n: sinceId + 1 }))
        timers.current.push(setTimeout(() => window.romiSim.connect(n.id, 9), 3500))
      }, 7000))
    },
    close() {
      setState({ key: "", until: 0, sinceId: 0 })
      toast(T("注册窗口已关闭"))
    },
  }
}

Object.assign(window, { NodesPage, NodeInspector, AddNodeFlow, RegisterDialog, useRegisterWindow, attention, useForm, IntervalField, canProvision })
