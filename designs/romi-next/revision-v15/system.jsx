// The v15 system: tokens and components, each theme in its own column.

const TOKENS = [
  ["表面", ["--bg", "--bg-raise", "--surface", "--surface-2", "--surface-3", "--surface-4"]],
  ["线条", ["--line", "--line-2", "--line-3"]],
  ["文字", ["--text", "--text-2", "--text-3"]],
  ["操作", ["--accent", "--accent-hover", "--accent-soft", "--accent-ink", "--focus"]],
  ["状态", ["--ok", "--ok-ink", "--warn", "--warn-ink", "--bad", "--bad-ink", "--idle", "--idle-ink"]],
  ["方向", ["--flow-down", "--flow-up", "--trend"]],
  ["数据", ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"]],
  ["地球", ["--globe-hi", "--globe-lo", "--globe-rim", "--globe-grid", "--globe-back"]],
]
const SIZES = ["--fs-display", "--fs-4xl", "--fs-3xl", "--fs-2xl", "--fs-xl", "--fs-lg", "--fs-base", "--fs-md", "--fs-sm", "--fs-xs"]
const LEADING = ["--lh-tight", "--lh-snug", "--lh-base", "--lh-loose"]
const SPACE = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48]
const RADII = ["--r-xs", "--r-sm", "--r-md", "--r-lg", "--r-xl"]
const DURATIONS = ["--t-fast", "--t", "--t-slow", "--t-enter", "--t-value", "--t-spin", "--t-beat", "--t-pulse", "--t-push", "--t-radar"]
const EASINGS = ["--ease", "--ease-out", "--spring"]
// One stand-in node per flow level, from a quiet link to a saturated one.
const LEVELS = [
  { country: "JP", rx: 48 * 1024, tx: 16 * 1024 },
  { country: "SG", rx: 3.2 * 1048576, tx: 1.1 * 1048576 },
  { country: "DE", rx: 42 * 1048576, tx: 18 * 1048576 },
]

// The computed value of a custom property, read inside the themed column.
function useToken(name) {
  const ref = useRef(null)
  const [value, setValue] = useState("")
  useLayoutEffect(() => setValue(getComputedStyle(ref.current).getPropertyValue(name).trim()), [name])
  return [ref, value]
}

function Swatch({ name }) {
  const [ref, value] = useToken(name)
  return (
    <div className="sw" ref={ref}>
      <span className="sw-chip" style={{ background: `var(${name})` }}></span>
      <span className="sw-name mono">{name}</span>
      <span className="sw-value mono">{value}</span>
    </div>
  )
}

function Token({ name, children }) {
  const [ref, value] = useToken(name)
  return (
    <div className="tok" ref={ref}>
      <span className="tok-name mono">{name}</span>
      <span className="tok-value mono">{value}</span>
      <span className="tok-sample">{children}</span>
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div className="sys-row">
      <p className="sys-label">{label}</p>
      <div className="sys-items">{children}</div>
    </div>
  )
}

function SystemColumn({ theme }) {
  const { nodes, tick } = useFleet()
  const [seg, setSeg] = useState("cards")
  const [tab, setTab] = useState("a")
  const [sw, setSw] = useState(true)
  const [ck, setCk] = useState(true)
  const [hover, setHover] = useState(null)
  const [filter, setFilter] = useState(null)
  const byId = (id) => nodes.find((n) => n.id === id)
  const hist = useMemo(() => window.romiSim.history(byId(2), 6, 90), [])
  const counts = STATUS_ORDER.reduce((c, key) => ({ ...c, [key]: nodes.filter((n) => fmt.connection(n) === key).length }), {})
  const home = byId(1)
  const place = home && window.romiGeo.place(home.country)
  const levels = LEVELS.map((l, i) => ({ id: 900 + i, name: l.country, country: l.country, online: true, last_seen: Date.now() / 1000, metrics: { cpu: 12, mem_used: 1, mem_total: 4, disk_used: 1, disk_total: 10, net_rx: l.rx, net_tx: l.tx } }))
  return (
    <section className="sys-col" data-theme={theme} aria-label={theme === "dark" ? T("深色主题") : T("浅色主题")}>
      <h2 className="sys-theme">{theme === "dark" ? T("深色") : T("浅色")}</h2>

      <h3 className="sys-h">{T("品牌")}</h3>
      <Row label={T("标记")}>
        {[16, 22, 32, 48].map((s) => <Mark key={s} size={s} />)}
        <span className="mark-tile" title={T("标签页图标")}><Mark size={26} /></span>
      </Row>
      <Row label={T("状态")}>
        {["ok", "warn", "bad"].map((t) => <span key={t} className="brand"><Brand tone={t} beat={t === "ok" ? tick : undefined} /></span>)}
      </Row>
      <Row label={T("昼夜与节点位置")}>
        <div className="sys-map"><DayMap nodes={nodes} theme={theme} label={T("昼夜与节点位置")} /></div>
      </Row>

      <h3 className="sys-h">{T("色彩")}</h3>
      {TOKENS.map(([group, names]) => (
        <Row key={group} label={T(group)}>
          <div className="sw-grid">{names.map((n) => <Swatch key={n} name={n} />)}</div>
        </Row>
      ))}

      <h3 className="sys-h">{T("字体与数字")}</h3>
      <Row label={T("字号")}>
        <div className="tok-list">
          {SIZES.map((name, i) => (
            <Token key={name} name={name}>
              <span style={{ fontSize: `var(${name})`, fontWeight: i < 3 ? 600 : 400 }} className={i < 3 ? "num" : undefined}>
                {i < 3 ? <>12.4<span className="unit">MiB/s</span></> : T("东京 · edge-01")}
              </span>
            </Token>
          ))}
        </div>
      </Row>
      <Row label={T("字重")}>
        {[400, 500, 600, 700].map((w) => <span key={w} className="tok-weight" style={{ fontWeight: w }}>{T("东京 · edge-01")} <span className="mono">{w}</span></span>)}
      </Row>
      <Row label={T("行高")}>
        <div className="tok-list">{LEADING.map((name) => <Token key={name} name={name} />)}</div>
      </Row>
      <Row label={T("数字")}>
        <div className="sys-stack">
          <p className="mono">{T("等宽 · 192.0.2.11 · node-1")}</p>
          <p className="num">{T("表格数字 · 1,284,512 · 12.4 MiB/s")}</p>
        </div>
      </Row>

      <h3 className="sys-h">{T("间距与尺寸")}</h3>
      <Row label={T("间距")}>
        <div className="space-scale">
          {SPACE.map((n) => <span key={n} className="space-step"><i style={{ width: n, height: n }}></i><span className="mono">{n}</span></span>)}
        </div>
      </Row>
      <Row label={T("图标")}>
        {[12, 14, 16, 20, 24].map((n) => <span key={n} className="icon-step"><Icon name="server" size={n} /><span className="mono">{n}</span></span>)}
      </Row>

      <h3 className="sys-h">{T("形状与层次")}</h3>
      <Row label={T("圆角")}>
        {RADII.map((r) => <span key={r} className="shape" style={{ borderRadius: `var(${r})` }}><span className="mono">{r}</span></span>)}
      </Row>
      <Row label={T("阴影")}>
        {["--shadow-1", "--shadow-2", "--shadow-3"].map((s) => <span key={s} className="shape shape-elev" style={{ boxShadow: `var(${s}), 0 0 0 1px var(--line)` }}><span className="mono">{s}</span></span>)}
      </Row>

      <h3 className="sys-h">{T("动效")}</h3>
      <Row label={T("时长")}>
        <div className="tok-list">
          {DURATIONS.map((name) => <Token key={name} name={name}><span className="motion-track"><i style={{ animationDuration: `var(${name})` }}></i></span></Token>)}
        </div>
      </Row>
      <Row label={T("缓动")}>
        <div className="tok-list">
          {EASINGS.map((name) => <Token key={name} name={name}><span className="motion-track"><i style={{ animationTimingFunction: `var(${name})` }}></i></span></Token>)}
        </div>
      </Row>

      <h3 className="sys-h">{T("操作")}</h3>
      <Row label={T("按钮")}>
        <Button kind="primary" icon="plus">{T("添加节点")}</Button>
        <Button icon="ticket">{T("批量注册")}</Button>
        <Button kind="ghost">{T("取消")}</Button>
        <Button kind="danger">{T("删除节点")}</Button>
        <Button kind="danger-ghost" icon="key-round">{T("换发")}</Button>
      </Row>
      <Row label={T("尺寸与状态")}>
        <Button size="sm">{T("小号")}</Button>
        <Button kind="primary" busy>{T("保存")}</Button>
        <Button disabled>{T("测试")}</Button>
        <IconButton label={T("切换深色主题")} icon="moon" kind="secondary" />
        <LangButton />
        <span className="search-trigger sys-trigger"><Icon name="search" /><span>{T("搜索或跳转")}</span><Kbd>⌘K</Kbd></span>
      </Row>
      <Row label={T("选择")}>
        <Segmented label={T("显示方式")} value={seg} onChange={setSeg} options={[{ value: "cards", label: T("卡片"), icon: "layout-grid" }, { value: "list", label: T("列表"), icon: "list" }]} />
        <Tabs label={T("示例页签")} idPrefix={`sys-${theme}`} value={tab} onChange={setTab} tabs={[{ value: "a", label: T("资源") }, { value: "b", label: T("流量") }, { value: "c", label: T("监测") }]} />
      </Row>
      <Row label={T("开关与勾选")}>
        <Switch checked={sw} onChange={setSw} label={T("离线通知")} detail={T("掉线超过宽限期推送一条，恢复在线时再推一条")} />
        <Check checked={ck} onChange={setCk}>{T("上传与下载相同")}</Check>
      </Row>

      <h3 className="sys-h">{T("表单")}</h3>
      <div className="form-grid sys-form">
        <Field label={T("名称")}><Input defaultValue={T("东京 · edge-01")} /></Field>
        <Field label={T("展示优先级")} hint={T("0–999999 整数，数字越大越靠前")}><Input defaultValue="90" /></Field>
        <Field label={T("上报间隔（秒）")} error={T("请输入 3–60 的整数")}><Input defaultValue="2" /></Field>
        <Field label={T("付款周期")}><Select defaultValue="monthly"><option value="monthly">{T("月付")}</option><option value="yearly">{T("年付")}</option></Select></Field>
        <Field label={T("当前密码")} hint={T("修改账号或密码都需要先验证当前密码。")}><PasswordInput defaultValue="romi-prototype" /></Field>
        <Field label={T("每月流量额度")} hint={T("0 表示不限")}><Input disabled defaultValue="1000" /></Field>
      </div>

      <h3 className="sys-h">{T("状态")}</h3>
      <Row label={T("连接")}>
        {[1, 6, 5, 10].map((id) => byId(id) && <StatusBadge key={id} node={byId(id)} beat={tick} />)}
      </Row>
      <Row label={T("按状态筛选")}>
        <div className="sys-tiles">
          <div className="status-tiles" role="group" aria-label={T("按状态筛选")}>
            {STATUS_ORDER.map((key) => (
              <button key={key} type="button" className="status-tile" data-status={key} aria-pressed={filter === key} disabled={!counts[key] && filter !== key} onClick={() => setFilter(filter === key ? null : key)}>
                <span className="status-tile-label"><StatusDot status={key} /><span>{fmt.CONNECTION[key]}</span></span>
                <b className="status-tile-count num">{counts[key]}</b>
              </button>
            ))}
          </div>
        </div>
      </Row>
      <Row label={T("方向")}>
        <DirValue dir="down" value={25.6} unit="MiB/s" />
        <DirValue dir="up" value={14.5} unit="MiB/s" />
        <span className="sys-flow"><FlowValue dir="down" value={907.6 * 1024} /><FlowValue dir="up" value={353 * 1024} /></span>
      </Row>
      <Row label={T("位置与标记")}>
        <Region code="JP" full />
        <LocalSky code="JP" text />
        <LocalSky code="US" text />
        <span className="tag"><Icon name="lock" size={12} />{T("私有")}</span>
        <span className="tag" data-tone="warn"><Icon name="calendar" size={12} />{T("5 天后到期")}</span>
        <span className="tag" data-tone="bad"><Icon name="hard-drive" size={12} />{T("磁盘 92%")}</span>
      </Row>
      <Row label={T("用量")}>
        <div className="sys-meters">
          <MeterRow label={T("正常")} pct={31} detail="24.8 / 80.0 GiB" />
          <MeterRow label={T("偏高")} pct={68} detail="5.44 / 8.00 GiB" />
          <MeterRow label={T("紧张")} pct={92} detail="73.6 / 80.0 GiB" />
          <MeterRow label={T("未知")} pct={null} detail={T("待上报")} />
        </div>
      </Row>
      <Row label={T("额度与期限")}>
        <div className="sys-quota">{byId(6) && <QuotaBar node={byId(6)} />}</div>
        <Ring value={29} max={30} size={56} stroke={5}>29</Ring>
        <Ring value={5} max={30} size={56} stroke={5} tone="warn">5</Ring>
        <Ring value={0} max={30} size={56} stroke={5} tone="bad">!</Ring>
      </Row>
      <Row label={T("提示")}>
        <div className="sys-stack">
          <Notice>{T("此节点还没有上报。")}</Notice>
          <Notice tone="warn" icon="key-round">{T("节点令牌仅本次显示，关闭后无法再次查看。")}</Notice>
          <Notice tone="bad">{T("恢复会覆盖现有数据并结束所有登录会话。")}</Notice>
          <div className="toast sys-toast"><Icon name="circle-check" /><span>{T("节点已保存")}</span></div>
        </div>
      </Row>
      <Row label={T("空与失败")}>
        <div className="sys-empties">
          <Empty compact icon="radar" title={T("还没有监测任务")} action={T("添加监测")} onAction={() => {}} />
          <Empty compact error title={T("会话列表加载失败")} action={T("重试")} onAction={() => {}} />
        </div>
      </Row>
      <Row label={T("复制")}>
        <CopyValue value="2001:db8::11" label=" IPv6" />
        <div className="sys-code"><CodeBlock code="tmp=$(mktemp) && curl -fsSL 'https://hub.example.invalid/install.sh' -o &quot;$tmp&quot;" label={T("复制命令")} /></div>
      </Row>

      <h3 className="sys-h">{T("地球")}</h3>
      <Row label={T("节点位置")}>
        {place && <Globe variant="detail" nodes={[home]} lon={place[0]} lat={place[1]} size={216} theme={theme} beat={tick} />}
        <span className="flow-key sys-flow-key" aria-hidden="true">
          <span data-dir="down"><i></i>{T("下载")}</span>
          <span data-dir="up"><i></i>{T("上传")}</span>
        </span>
      </Row>
      <Row label={T("流量强度")}>
        <div className="sys-globes">
          {levels.map((n) => {
            const p = window.romiGeo.place(n.country)
            return (
              <figure key={n.id} className="sys-globe">
                <Globe variant="detail" nodes={[n]} lon={p[0]} lat={p[1]} size={160} theme={theme} beat={tick} />
                <figcaption><FlowValue dir="down" value={n.metrics.net_rx} /><FlowValue dir="up" value={n.metrics.net_tx} /></figcaption>
              </figure>
            )
          })}
        </div>
      </Row>

      <h3 className="sys-h">{T("数据")}</h3>
      <Row label={T("实时迹线")}>
        <div className="sys-spark">{byId(2) && <Sparkline points={window.romiSim.spark(2)} get={(p) => p.cpu} max={100} beat={tick} />}</div>
      </Row>
      <div className="sys-chart">
        <HistoryChart
          title={T("网络速率")}
          summary={T("6 小时")}
          ts={hist.map((p) => p.ts)}
          kind="rate"
          step={hist[1] ? hist[1].ts - hist[0].ts : 240}
          domain={[hist[0]?.ts || 0, hist[hist.length - 1]?.ts || 1]}
          hover={hover}
          onHover={setHover}
          series={[
            { key: "rx", label: T("下载"), color: "var(--flow-down)", values: hist.map((p) => p.net_rx) },
            { key: "tx", label: T("上传"), color: "var(--flow-up)", values: hist.map((p) => p.net_tx) },
          ]}
        />
      </div>
    </section>
  )
}

function SystemPage() {
  const locale = useLocale()
  useLayoutEffect(() => { document.documentElement.dataset.theme = "light" }, [])
  useEffect(() => { document.title = T("romi 设计规范") }, [locale])
  useFavicon("ok")
  return (
    <main className="sys" id="main" data-screen-id="system">
      <header className="sys-head">
        <span className="brand"><Brand /></span>
        <h1>{T("设计规范 v15")}</h1>
        <LangButton />
      </header>
      <div className="sys-cols">
        <SystemColumn theme="light" />
        <SystemColumn theme="dark" />
      </div>
      <Toasts />
    </main>
  )
}

ReactDOM.createRoot(document.getElementById("root")).render(<SystemPage />)
