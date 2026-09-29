// The status page at `/` and `/node/{id}`.

// What the hub leaves out of the anonymous snapshot.
const PANEL_ONLY = ["hostname", "ip", "ipv4", "ipv6", "remark", "notify"]
function anonymous(node) {
  const view = { ...node }
  for (const key of PANEL_ONLY) delete view[key]
  return view
}

// The viewer's offset from UTC, which every time on the page is shown in.
function zoneLabel(date = new Date()) {
  const off = -date.getTimezoneOffset()
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")
  const mm = String(Math.abs(off) % 60).padStart(2, "0")
  return `UTC${off < 0 ? "−" : "+"}${hh}:${mm}`
}

function Footer({ nodes, connected, theme, tone }) {
  const regions = new Set(nodes.map((n) => n.country).filter(Boolean)).size
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-meta">
          <span className="brand footer-brand"><Brand tone={tone} version={window.romiFixtures.version} /></span>
          <ul className="footer-facts">
            <li className="footer-live" data-live={connected}><span className="live-dot"></span>{connected ? T("实时连接") : T("连接中断")}</li>
            <li className="num">{T("{n} 个节点", { n: nodes.length })} · {T("{n} 个国家/地区", { n: regions })}</li>
            <li className="num">{T("时间按 {zone} 显示", { zone: zoneLabel() })}</li>
          </ul>
        </div>
        <DayMap nodes={nodes} theme={theme} label={T("昼夜与节点位置")} />
      </div>
    </footer>
  )
}

function PublicApp() {
  const [theme, toggleTheme] = useTheme()
  const locale = useLocale()
  const { nodes: all, tick, connected } = useFleet()
  const [route, go] = useRoute("")
  const settings = window.romiFixtures.settings
  const params = new URLSearchParams(location.search)
  const [view, setViewState] = useState(() => params.get("view") || sessionStorage.getItem("romi-v15-view") || settings.public_default_view)
  const setView = (v) => {
    sessionStorage.setItem("romi-v15-view", v)
    setViewState(v)
  }
  const [palette, setPalette] = useState(false)
  const [state, setState] = useState(scenario === "loading" ? "loading" : scenario === "error" ? "error" : "ready")
  useEffect(() => {
    if (scenario === "offline") window.romiSim.setConnected(false)
  }, [])
  // The page keeps its data through the first load.
  useEffect(() => {
    if (scenario === "loading") return
    if (state === "loading") setState("ready")
  }, [])

  const nodes = scenario === "empty" ? [] : all.filter((n) => n.public).map(anonymous)
  const tone = fleetTone(nodes)
  useFavicon(tone)
  const open = (n) => go(`node/${n.id}`)
  useHotkey((e, typing) => !typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")), () => setPalette(true))

  const selected = route[0] === "node" ? nodes.find((n) => String(n.id) === route[1]) : null
  useEffect(() => {
    document.title = selected ? `${selected.name} · ${settings.site_name}` : settings.site_name
  }, [selected && selected.name, locale])

  if (scenario === "closed")
    return (
      <div className="closed-page">
        <Globe variant="backdrop" theme={theme} />
        <div className="closed-card">
          <Mark size={40} />
          <h1>{T("需要登录")}</h1>
          <p>{T("此站点的状态页未公开，登录后查看节点。")}</p>
          <a className="btn btn-primary" href="index.html?state=login">{T("前往登录")}</a>
        </div>
      </div>
    )

  let content
  if (route[0] === "node") {
    content = selected ? (
      <NodeDetail node={selected} beat={tick} theme={theme} onBack={() => go("")} scenarioState={scenario} />
    ) : (
      <Empty icon="map-pin" title={T("节点不存在")} detail={T("它可能未公开或已被删除。")} action={T("返回全部节点")} onAction={() => go("")} />
    )
  } else {
    content = (
      <FleetView
        nodes={nodes}
        beat={tick}
        theme={theme}
        onOpen={open}
        view={view}
        setView={setView}
        state={state}
        connected={connected}
        onRetry={() => { setState("ready"); toast(T("已重新加载")) }}
      />
    )
  }

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main").focus() }}>{T("跳到主要内容")}</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); go("") }}>
            <Brand name={settings.site_name} tone={tone} beat={connected ? tick : undefined} />
          </a>
          <div className="topbar-actions">
            <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
              <Icon name="search" />
              <span>{T("搜索节点")}</span>
              <Kbd>/</Kbd>
            </button>
            <IconButton className="search-trigger-icon" label={T("搜索节点")} icon="search" onClick={() => setPalette(true)} />
            <LangButton />
            <ThemeButton theme={theme} onToggle={toggleTheme} />
            <a className="btn btn-ghost" href="index.html?state=login">{T("登录")}</a>
          </div>
        </div>
      </header>
      <main id="main" className="page" tabIndex={-1} data-screen-id={route[0] === "node" ? "node-detail" : "public"}>
        {content}
      </main>
      <Footer nodes={nodes} connected={connected} theme={theme} tone={tone} />
      {palette && <Palette items={nodeItems(nodes, open)} onClose={() => setPalette(false)} />}
      <Toasts />
    </>
  )
}

ReactDOM.createRoot(document.getElementById("root")).render(<PublicApp />)
