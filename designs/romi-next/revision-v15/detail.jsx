// One node: vitals now, the billing period, the machine, and its history.

const RANGES = [
  { hours: 1, label: "1 小时" },
  { hours: 6, label: "6 小时" },
  { hours: 24, label: "24 小时" },
  { hours: 168, label: "7 天" },
]
const ADMIN_RANGES = [...RANGES, { hours: 720, label: "30 天" }, { hours: 2160, label: "90 天" }, { hours: 8760, label: "1 年" }]

// Hampel filter: a sample far from its window's median is replaced by that
// median; everything else passes through unchanged.
function despike(values, window = 7, sigmas = 3) {
  const half = window >> 1
  const med = (xs) => {
    const s = xs.slice().sort((a, b) => a - b)
    return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null
  }
  return values.map((v, i) => {
    if (v == null) return v
    const near = values.slice(Math.max(0, i - half), i + half + 1).filter((x) => x != null)
    const mid = med(near)
    const mad = med(near.map((x) => Math.abs(x - mid)))
    return mad > 0 && Math.abs(v - mid) > sigmas * 1.4826 * mad ? mid : v
  })
}

function VitalTile({ icon, label, value, unit, sub, tone, spark, get, max, beat, color }) {
  return (
    <div className="vital" data-tone={tone}>
      <div className="vital-head">
        <span className="vital-label"><Icon name={icon} size={14} />{label}</span>
      </div>
      <div className="vital-value num">
        {value == null ? "—" : typeof value === "number" ? <AnimatedNumber value={value} format={(v) => (unit === "%" ? v.toFixed(0) : String(Math.round(v)))} /> : value}
        {value != null && unit && <span className="unit">{unit}</span>}
      </div>
      <div className="vital-sub">{sub}</div>
      {spark && <Sparkline points={spark} get={get} max={max} beat={beat} height={30} color={color} />}
    </div>
  )
}

function Fact({ label, children, mono }) {
  if (children === null || children === undefined || children === "") return null
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{children}</dd>
    </div>
  )
}

function BillingPanel({ node }) {
  const exp = fmt.expiry(node)
  const cycleDays = { monthly: 30, quarterly: 91, semiannual: 182, yearly: 365, biennial: 730, triennial: 1095 }[node.billing_cycle] || 30
  const left = exp.days == null ? null : Math.max(0, exp.days)
  return (
    <section className="panel" aria-labelledby="billing-title">
      <h2 id="billing-title" className="panel-title"><Icon name="wallet" size={16} />{T("账单")}</h2>
      <div className="billing-main">
        <Ring value={left ?? cycleDays} max={cycleDays} size={64} stroke={5} tone={exp.tone === "bad" ? "bad" : exp.tone === "warn" ? "warn" : exp.days == null ? "muted" : "accent"}>
          {exp.days == null ? "∞" : exp.days < 0 ? "!" : exp.days}
        </Ring>
        <div className="billing-text">
          <strong className="num">{fmt.price(node)}</strong>
          <span className={`ink-${exp.tone}`}>{exp.text}</span>
        </div>
      </div>
      <dl className="facts">
        <Fact label={T("到期日期")}>{node.expires_at || fmt.FOREVER}</Fact>
        <Fact label={T("付款周期")}>{fmt.CYCLES[node.billing_cycle] || node.billing_cycle}</Fact>
      </dl>
    </section>
  )
}

function TrafficPanel({ node, threshold }) {
  return (
    <section className="panel" aria-labelledby="traffic-title">
      <h2 id="traffic-title" className="panel-title"><Icon name="arrow-down-up" size={16} />{T("流量")}</h2>
      <QuotaBar node={node} threshold={threshold} />
      <dl className="facts facts-2">
        <Fact label={T("计费方式")}>{fmt.MODES[node.traffic_mode]}</Fact>
        <Fact label={T("每月重置日")}>{T("{n} 日", { n: node.traffic_reset_day || 1 })}</Fact>
        <Fact label={T("今日下载 / 上传")}><span className="num">{fmt.bytes(node.day_rx)} / {fmt.bytes(node.day_tx)}</span></Fact>
        <Fact label={T("累计下载 / 上传")}><span className="num">{fmt.bytes(node.total_rx)} / {fmt.bytes(node.total_tx)}</span></Fact>
        <Fact label={T("可用带宽 · 下载 / 上传")}>{`${fmt.bandwidth(node.bandwidth_down)} / ${fmt.bandwidth(node.bandwidth_up)}`}</Fact>
      </dl>
    </section>
  )
}

function SystemPanel({ node, admin }) {
  const m = node.online ? node.metrics : null
  return (
    <section className="panel" aria-labelledby="system-title">
      <h2 id="system-title" className="panel-title"><Icon name="server" size={16} />{T("系统")}</h2>
      <dl className="facts facts-2">
        <Fact label={T("系统")}>{node.os ? fmt.osName(node.os) : T("待上报")}</Fact>
        <Fact label={T("内核")} mono>{node.kernel || "—"}</Fact>
        <Fact label={T("架构")} mono>{node.arch || "—"}</Fact>
        <Fact label={T("虚拟化")}>{node.virt ? node.virt.toUpperCase() : "—"}</Fact>
        <Fact label="CPU">{node.cpu_name ? `${node.cpu_name} · ${node.cpu_cores} vCPU` : T("待上报")}</Fact>
        <Fact label={T("内存 / Swap")}><span className="num">{node.mem_total ? fmt.bytes(node.mem_total) : "—"} / {node.swap_total ? fmt.bytes(node.swap_total) : T("未启用")}</span></Fact>
        <Fact label={T("磁盘")}><span className="num">{node.disk_total ? fmt.bytes(node.disk_total) : "—"}</span></Fact>
        <Fact label={T("Agent 版本")} mono>{node.agent_version || T("未上报")}</Fact>
      </dl>
      {admin && (
        <dl className="facts facts-2 facts-admin">
          <Fact label="IPv4"><CopyValue value={node.ipv4} label=" IPv4" /></Fact>
          <Fact label="IPv6"><CopyValue value={node.ipv6} label=" IPv6" /></Fact>
          <Fact label={T("接入标识")}><CopyValue value={`node-${node.id}`} label={T("接入标识")} /></Fact>
          <Fact label={T("备注")}>{node.remark || "—"}</Fact>
        </dl>
      )}
    </section>
  )
}

function useHistory(node, hours, key) {
  const [state, setState] = useState({ loading: true, metrics: [], pings: [] })
  const minute = Math.floor(Date.now() / 60000)
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }))
    const t = setTimeout(() => {
      setState({ loading: false, metrics: window.romiSim.history(node, hours, 240), pings: window.romiSim.pings(node, Math.min(hours, 24), window.romiFixtures.probes) })
    }, 380)
    return () => clearTimeout(t)
  }, [node.id, hours, minute, key])
  return state
}

function HistorySection({ node, admin, scenarioState, onRetry }) {
  const [tab, setTab] = useState("resources")
  const [ranges, setRanges] = useState({ resources: 24, traffic: 24, latency: 6 })
  const [zoom, setZoom] = useState(null)
  const [hover, setHover] = useState(null)
  const [asTable, setAsTable] = useState(false)
  const [smooth, setSmooth] = useState(false)
  const [hidden, setHidden] = useState([])
  const [retryKey, setRetryKey] = useState(0)
  const hours = ranges[tab]
  const { loading, metrics, pings } = useHistory(node, tab === "latency" ? Math.min(hours, 24) : hours, retryKey)
  const available = (tab === "latency" ? RANGES.filter((r) => r.hours <= 24) : admin ? ADMIN_RANGES : RANGES)
  const end = Math.floor(Date.now() / 1000 / 60) * 60
  const domain = zoom || [end - hours * 3600, end]
  useEffect(() => setZoom(null), [tab, hours])

  const ts = metrics.map((p) => p.ts)
  const step = metrics[1] ? metrics[1].ts - metrics[0].ts : 60
  const pct = (used, total) => (used == null ? null : (used / total) * 100)
  const memStatus = (enabled, value) => (enabled ? null : T("未启用"))
  const charts =
    tab === "resources"
      ? [
          { title: "CPU", kind: "percent", series: [{ key: "cpu", label: "CPU", color: "var(--trend)", values: metrics.map((p) => p.cpu) }] },
          {
            title: T("内存"),
            kind: "bytes",
            max: node.mem_total,
            series: [
              { key: "ram", label: "RAM", color: "var(--trend)", values: metrics.map((p) => p.mem_used) },
              { key: "zram", label: "ZRAM", color: "var(--series-3)", dash: "5 3", area: false, values: metrics.map((p) => p.zram_used), status: memStatus(node.metrics && node.metrics.zram_total > 0) },
              { key: "swap", label: "Swap", color: "var(--series-4)", dash: "2 3", area: false, values: metrics.map((p) => p.swap_disk_used), status: memStatus(node.swap_total > 0) },
            ],
          },
          { title: T("磁盘"), kind: "percent", series: [{ key: "disk", label: T("磁盘"), color: "var(--trend)", values: metrics.map((p) => pct(p.disk_used, node.disk_total)) }] },
          { title: T("进程数"), kind: "count", series: [{ key: "procs", label: T("进程"), color: "var(--trend)", values: metrics.map((p) => p.procs) }] },
          {
            title: T("TCP / UDP 连接"),
            kind: "count",
            series: [
              { key: "tcp", label: "TCP", color: "var(--trend)", values: metrics.map((p) => p.tcp) },
              { key: "udp", label: "UDP", color: "var(--series-3)", values: metrics.map((p) => p.udp), area: false },
            ],
          },
        ]
      : tab === "traffic"
        ? [
            {
              title: T("网络速率"),
              kind: "rate",
              wide: true,
              series: [
                { key: "rx", label: T("下载"), color: "var(--flow-down)", values: metrics.map((p) => p.net_rx) },
                { key: "tx", label: T("上传"), color: "var(--flow-up)", values: metrics.map((p) => p.net_tx) },
              ],
            },
          ]
        : []
  // Transfer inside the visible window, from the bucket rates.
  const moved = (k) => metrics.reduce((t, p) => (p.ts >= domain[0] && p.ts <= domain[1] ? t + p[k] * p.step : t), 0)
  const peak = (values) => Math.max(0, ...values.filter((v, i) => v != null && ts[i] >= domain[0] && ts[i] <= domain[1]))
  // An odd count would leave the last row half empty, so the first chart takes
  // the whole row and the rest pair up.
  const lead = (count, i) => count % 2 === 1 && i === 0

  const [failed, setFailed] = useState(scenarioState === "history-error")
  const noHistory = scenarioState === "history-empty" || (!loading && !metrics.length && tab !== "latency") || (!loading && tab === "latency" && !pings.length)
  const tabs = [
    { value: "resources", label: T("资源"), icon: "cpu" },
    { value: "traffic", label: T("流量"), icon: "arrow-down-up" },
    { value: "latency", label: T("监测"), icon: "radar" },
  ]
  return (
    <section className="history" aria-labelledby="history-title">
      <div className="history-bar">
        <h2 id="history-title" className="section-title">{T("历史")}</h2>
        <Tabs tabs={tabs} value={tab} onChange={setTab} label={T("历史类型")} idPrefix="history" />
        <div className="history-tools">
          <Segmented
            size="sm"
            label={T("时间范围")}
            value={String(hours)}
            onChange={(v) => setRanges({ ...ranges, [tab]: Number(v) })}
            options={available.map((r) => ({ value: String(r.hours), label: T(r.label) }))}
          />
          {tab === "latency" && <Switch checked={smooth} onChange={setSmooth} label={T("平滑")} />}
          <Segmented
            size="sm"
            label={T("历史显示方式")}
            value={asTable ? "table" : "chart"}
            onChange={(v) => setAsTable(v === "table")}
            options={[{ value: "chart", label: T("图表") }, { value: "table", label: T("表格") }]}
          />
        </div>
      </div>
      {zoom && (
        <div className="zoom-note">
          <Icon name="search" size={14} />
          <span className="num">{fmt.full(zoom[0] * 1000)} – {fmt.full(zoom[1] * 1000)}</span>
          <button type="button" className="link-button" onClick={() => setZoom(null)}>{T("恢复完整范围")}</button>
        </div>
      )}
      <div id={`history-panel-${tab}`} role="tabpanel" aria-labelledby={`history-${tab}`} className={cx("history-body", loading && "is-loading")}>
        {failed ? (
          <Empty error title={T("历史加载失败")} detail={T("当前历史不可用，请稍后重试。")} action={T("重试")} onAction={() => { setFailed(false); setRetryKey(retryKey + 1); onRetry && onRetry() }} />
        ) : noHistory ? (
          <Empty icon="history" title={T("暂无历史数据")} detail={tab === "latency" ? T("此节点没有分配监测任务，或还没有结果。") : T("收到采样后，历史会显示在这里。")} />
        ) : asTable ? (
          tab === "latency" ? (
            <HistoryTable ts={(pings[0]?.rows || []).map((r) => r.ts)} charts={pings.map((p) => ({ title: p.name, kind: "ms", series: [{ key: "latency", label: T("延迟"), values: p.rows.map((r) => r.latency) }] }))} />
          ) : (
            <HistoryTable ts={ts} charts={charts} />
          )
        ) : tab === "latency" ? (
          <div className="chart-grid">
            {pings.map((p, i) => {
              const rowTs = p.rows.map((r) => r.ts)
              const raw = p.rows.map((r) => r.latency)
              const values = smooth ? despike(raw) : raw
              const med = values.filter((v) => v != null).sort((a, b) => a - b)[Math.floor(values.filter((v) => v != null).length / 2)]
              return (
                <HistoryChart
                  key={p.id}
                  lead={lead(pings.length, i)}
                  height={lead(pings.length, i) ? 208 : 176}
                  title={p.name}
                  summary={T("中位 {ms} ms · 丢包 {loss}%", { ms: med ? Math.round(med) : "—", loss: p.loss.toFixed(p.loss < 1 ? 2 : 1) })}
                  ts={rowTs}
                  kind="ms"
                  step={rowTs[1] ? rowTs[1] - rowTs[0] : 60}
                  domain={zoom || [end - Math.min(hours, 24) * 3600, end]}
                  hover={rowTs.includes(hover) ? hover : null}
                  onHover={setHover}
                  onZoom={setZoom}
                  loss={p.rows.map((r) => r.loss || 0)}
                  series={[{ key: "latency", label: T("延迟"), color: "var(--trend)", values, band: p.rows.map((r) => r.band || null), area: false }]}
                />
              )
            })}
          </div>
        ) : (
          <div className="chart-grid">
            {charts.map((c, i) => (
              <HistoryChart
                key={c.title}
                lead={lead(charts.length, i)}
                title={c.title}
                summary={
                  c.kind === "percent"
                    ? T("峰值 {pct}%", { pct: peak(c.series[0].values).toFixed(0) })
                    : c.kind === "rate"
                      ? T("此时段 ↓ {down} · ↑ {up}", { down: fmt.bytes(moved("net_rx")), up: fmt.bytes(moved("net_tx")) })
                      : c.kind === "bytes"
                        ? T("物理内存 {size}", { size: fmt.bytes(node.mem_total) })
                        : T("峰值 {value}", { value: peak(c.series[0].values) })
                }
                ts={ts}
                kind={c.kind}
                step={step}
                domain={domain}
                hover={hover}
                onHover={setHover}
                onZoom={setZoom}
                height={c.wide ? 260 : lead(charts.length, i) ? 208 : 176}
                max={c.max}
                series={c.series}
              />
            ))}
          </div>
        )}
      </div>
      <p className="history-hint">{T("在图表上拖动可放大，双击恢复。")}</p>
    </section>
  )
}

function NodeDetail({ node, beat, theme, admin, onBack, backLabel = T("全部节点"), onManage, scenarioState, threshold = 80 }) {
  const f = nodeFacts(node)
  const place = window.romiGeo.place(node.country)
  const down = outage(node)
  const spark = window.romiSim.spark(node.id)
  const m = f.m
  return (
    <article className="detail" data-status={f.status}>
      <a className="back-link" href={admin ? "#/nodes" : "#/"} onClick={(e) => { e.preventDefault(); onBack() }}>
        <Icon name="arrow-left" size={16} />
        {backLabel}
      </a>
      <header className="detail-head" style={{ viewTransitionName: `node-${node.id}` }}>
        <div className="detail-id">
          <div className="detail-where">
            {node.country ? <Region code={node.country} full /> : <span className="muted">{T("未定位")}</span>}
            <LocalSky code={node.country} text />
            {admin && !node.public && <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>}
          </div>
          <h1 className="detail-name">{node.name}</h1>
          <div className="detail-line">
            <StatusBadge node={node} beat={beat} />
            <span className="detail-meta">{systemLine(node)}</span>
          </div>
          <p className="detail-uptime num">
            <span>{T("连续在线")} <b>{fmt.continuousUptime(node)}</b></span>
            <span>{T("本次启动")} <b>{m ? fmt.uptime(m.uptime) : "—"}</b></span>
            {!node.online && node.last_seen > 0 && <span>{T("最后上报")} <b>{fmt.full(node.last_seen * 1000)}</b></span>}
          </p>
          {admin && (
            <div className="detail-actions">
              <Button kind="primary" icon="sliders-horizontal" onClick={() => onManage(node)}>{T("管理节点")}</Button>
            </div>
          )}
        </div>
        {place && <Globe variant="detail" nodes={[node]} lon={place[0]} lat={place[1]} size={216} theme={theme} beat={beat} />}
      </header>
      {down && <Notice tone={down.tone} icon={down.tone === "bad" ? "wifi-off" : "loader-circle"}>{T("{text}。历史数据仍可查看。", { text: down.text })}</Notice>}
      {f.status === "never" && <Notice icon="clock">{T("此节点还没有上报。安装 Agent 后，实时数据和历史会显示在这里。")}</Notice>}
      <div className="vitals">
        <VitalTile icon="cpu" label="CPU" value={f.cpu} unit="%" tone={fmt.tone(f.cpu)} sub={m ? T("负载 {load}", { load: m.load.map((v) => v.toFixed(2)).join(" · ") }) : node.cpu_cores ? `${node.cpu_cores} vCPU` : T("待上报")} spark={spark} get={(p) => p.cpu} max={100} beat={beat} color="var(--trend)" />
        <VitalTile icon="memory-stick" label={T("内存")} value={f.mem} unit="%" tone={fmt.tone(f.mem)} sub={m ? `${fmt.pair(m.mem_used, m.mem_total)}${m.zram_total > 0 ? ` · ZRAM ${fmt.bytes(m.zram_used)}` : ""}${m.swap_total > 0 ? ` · Swap ${fmt.bytes(m.swap_used)}` : ""}` : T("待上报")} spark={spark} get={(p) => p.mem} beat={beat} color="var(--trend)" />
        <VitalTile icon="hard-drive" label={T("磁盘")} value={f.disk} unit="%" tone={fmt.tone(f.disk)} sub={m ? fmt.pair(m.disk_used, m.disk_total) : T("待上报")} />
        <VitalTile icon="arrow-down-up" label={T("网络")} value={m ? <span className="vital-rates"><FlowValue dir="down" value={m.net_rx} /><FlowValue dir="up" value={m.net_tx} /></span> : null} sub={T("带宽 {bandwidth}", { bandwidth: fmt.bandwidth(node.bandwidth_down) })} spark={spark} get={(p) => p.rx} beat={beat} color="var(--flow-down)" />
        <VitalTile icon="network" label={T("连接")} value={m ? <span className="vital-pair"><span>TCP <b>{m.tcp}</b></span><span>UDP <b>{m.udp}</b></span></span> : null} sub={T("当前连接数")} />
        <VitalTile icon="activity" label={T("进程")} value={m ? m.procs : null} sub={T("当前进程数")} />
      </div>
      <div className="panels">
        <TrafficPanel node={node} threshold={threshold} />
        <BillingPanel node={node} />
        <SystemPanel node={node} admin={admin} />
      </div>
      <HistorySection key={node.id} node={node} admin={admin} scenarioState={scenarioState} />
    </article>
  )
}

Object.assign(window, { NodeDetail, HistorySection, VitalTile, Fact, RANGES, ADMIN_RANGES })
