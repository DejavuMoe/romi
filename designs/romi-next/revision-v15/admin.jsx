// The panel at `/admin/`: sign-in, the shell, and routing between sections.

const NAV = [
  { id: "nodes", label: "节点", icon: "server" },
  { id: "probes", label: "监测", icon: "radar" },
  { id: "notify", label: "通知", icon: "bell" },
  { id: "data", label: "数据", icon: "database" },
  { id: "security", label: "安全", icon: "shield" },
  { id: "settings", label: "设置", icon: "settings" },
]

function Login({ site, theme, onTheme, onLogin, publicOpen, notice }) {
  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const fails = useRef(0)
  const submit = (e) => {
    e.preventDefault()
    if (!account || !password) return setError(T("请填写账号和密码"))
    setBusy(true)
    setError("")
    setTimeout(() => {
      setBusy(false)
      if (fails.current >= 4) return setError(T("尝试次数过多，请稍后再试"))
      if (account !== "admin" || password !== "romi-prototype") {
        fails.current++
        setError(T("账号或密码不正确"))
        return
      }
      onLogin()
    }, 700)
  }
  return (
    <div className="login" data-screen-id="login">
      <Globe variant="backdrop" theme={theme} />
      <div className="login-corner"><LangButton /><ThemeButton theme={theme} onToggle={onTheme} /></div>
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <Brand name={site} size={28} />
        </div>
        <h1>{T("登录")}</h1>
        {notice && <Notice tone="info" icon="info">{notice}</Notice>}
        <Field label={T("账号")}>
          <Input data-autofocus autoComplete="username" value={account} onChange={(e) => { setAccount(e.target.value); setError("") }} />
        </Field>
        <Field label={T("密码")}>
          <PasswordInput autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError("") }} />
        </Field>
        <p className="login-error" role="alert">{error && <><Icon name="circle-alert" size={14} />{error}</>}</p>
        <Button kind="primary" type="submit" busy={busy} className="login-submit">{busy ? T("登录中…") : T("登录")}</Button>
        {publicOpen && <a className="login-back" href="public.html"><Icon name="arrow-left" size={14} />{T("返回公开状态页")}</a>}
      </form>
    </div>
  )
}

function Sidebar({ route, go, counts, connected, account, onLogout, onNavigate, tone, beat, site }) {
  return (
    <div className="sidebar-inner">
      <a className="brand" href="#/nodes" onClick={(e) => { e.preventDefault(); go("nodes"); onNavigate && onNavigate() }}>
        <Brand name={site} tone={tone} beat={connected ? beat : undefined} version={window.romiFixtures.version} />
      </a>
      <nav className="side-nav" aria-label={T("主导航")}>
        {NAV.map((item) => (
          <a
            key={item.id}
            href={`#/${item.id}`}
            aria-current={route === item.id ? "page" : undefined}
            onClick={(e) => { e.preventDefault(); go(item.id, { animate: false }); onNavigate && onNavigate() }}
          >
            <Icon name={item.icon} size={16} />
            <span>{T(item.label)}</span>
            {counts[item.id] !== undefined && <span className="nav-count num">{counts[item.id]}</span>}
          </a>
        ))}
      </nav>
      <div className="side-foot">
        <a className="side-link" href="public.html">
          <Icon name="globe" size={16} />
          <span>{T("公开状态页")}</span>
          <Icon name="arrow-up-right" size={14} className="side-link-go" />
        </a>
        <div className="side-account">
          <span className="avatar" aria-hidden="true">{account.slice(0, 1).toUpperCase()}</span>
          <span className="side-account-text">
            <span className="side-account-name">{account}</span>
            <span className="side-live" data-live={connected}>
              <span className="live-dot"></span>
              {connected ? T("实时连接") : T("连接中断")}
            </span>
          </span>
          <IconButton label={T("退出登录")} icon="log-out" onClick={onLogout} tip="top" />
        </div>
      </div>
    </div>
  )
}

function AdminApp() {
  const [theme, toggleTheme] = useTheme()
  const locale = useLocale()
  const { nodes: live, tick, connected } = useFleet()
  const [route, go] = useRoute("nodes")
  const [logged, setLogged] = useState(scenario !== "login")
  const [loginNotice, setLoginNotice] = useState("")
  const [settings, setSettings] = useState(() => ({ ...window.romiFixtures.settings }))
  const [probes, setProbes] = useState(() => window.romiFixtures.probes.map((p) => ({ ...p })))
  const [pageState, setPageState] = useState(scenario === "loading" ? "loading" : scenario === "error" ? "error" : "ready")
  const [palette, setPalette] = useState(false)
  const [menu, setMenu] = useState(false)
  const [inspect, setInspect] = useState(null)
  const [adding, setAdding] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [expired, setExpired] = useState(scenario === "permission")
  const reg = useRegisterWindow()
  useEffect(() => {
    if (scenario === "offline") window.romiSim.setConnected(false)
    const open = new URLSearchParams(location.search).get("open")
    if (open === "add") setAdding(true)
    if (open === "register") setRegistering(true)
    if (open && open.startsWith("inspect-")) setInspect({ id: Number(open.split("-")[1]), tab: open.split("-")[2] || "overview" })
  }, [])

  const nodes = scenario === "empty" ? [] : live
  const tone = fleetTone(nodes)
  useFavicon(tone)
  useHotkey((e, typing) => logged && !typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")), () => setPalette(true), [logged])
  const section = route[0] === "node" ? "nodes" : NAV.some((n) => n.id === route[0]) ? route[0] : "nodes"
  const selected = route[0] === "node" ? nodes.find((n) => String(n.id) === route[1]) : null
  const inspected = inspect && nodes.find((n) => n.id === inspect.id)
  const openDetail = (n) => go(`node/${n.id}`)
  const logout = (text) => {
    setLogged(false)
    setLoginNotice(typeof text === "string" ? text : "")
    setInspect(null)
  }
  useEffect(() => {
    const label = selected ? selected.name : T(NAV.find((n) => n.id === section)?.label)
    document.title = logged ? `${label} · ${settings.site_name}` : T("登录 · {site_name}", { site_name: settings.site_name })
  }, [section, selected && selected.name, logged, locale])

  if (!logged)
    return (
      <>
        <Login site={settings.site_name} theme={theme} onTheme={toggleTheme} publicOpen={settings.public_page === "on"} notice={loginNotice} onLogin={() => { setLogged(true); setLoginNotice(""); setExpired(false); toast(T("已登录")) }} />
        <Toasts />
      </>
    )

  const online = nodes.filter((n) => n.online).length
  const counts = { nodes: nodes.length, probes: probes.length }
  const retry = () => { setPageState("ready"); toast(T("已重新加载")) }
  const titles = {
    nodes: [T("节点"), nodes.length ? T("{n} 个节点 · {online} 在线", { n: nodes.length, online }) : ""],
    probes: [T("监测"), ""],
    notify: [T("通知"), ""],
    data: [T("数据"), ""],
    security: [T("安全"), ""],
    settings: [T("设置"), ""],
  }
  const [title, subtitle] = selected ? [selected.name, ""] : titles[section]

  let page
  if (expired) {
    page = <Empty icon="lock" title={T("登录已失效")} detail={T("当前会话已结束，请重新登录后继续。")} action={T("重新登录")} onAction={() => logout("")} />
  } else if (route[0] === "node") {
    page = selected ? (
      <NodeDetail node={selected} beat={tick} theme={theme} admin backLabel={T("节点")} onBack={() => go("nodes")} onManage={(n) => setInspect({ id: n.id, tab: "overview" })} scenarioState={scenario} threshold={Number(settings.notify_traffic) || 80} />
    ) : (
      <Empty icon="map-pin" title={T("节点不存在")} detail={T("它可能已被删除。")} action={T("返回节点")} onAction={() => go("nodes")} />
    )
  } else if (section === "nodes") {
    page = (
      <NodesPage
        nodes={nodes}
        beat={tick}
        settings={settings}
        state={pageState}
        onRetry={retry}
        connected={connected}
        onInspect={(n) => setInspect({ id: n.id, tab: "overview" })}
        onOpen={openDetail}
        onAdd={() => setAdding(true)}
        onRegister={() => setRegistering(true)}
      />
    )
  } else if (section === "probes") page = <ProbesPage probes={probes} setProbes={setProbes} nodes={nodes} state={pageState} onRetry={retry} />
  else if (section === "notify") page = <NotifyPage settings={settings} setSettings={setSettings} nodes={nodes} state={pageState} onRetry={retry} />
  else if (section === "data") page = <DataPage settings={settings} setSettings={setSettings} state={pageState} onRetry={retry} onRestored={() => logout(T("已恢复，请重新登录"))} />
  else if (section === "security") page = <SecurityPage settings={settings} setSettings={setSettings} state={pageState} onRetry={retry} />
  else page = <SettingsPage settings={settings} setSettings={setSettings} state={pageState} onRetry={retry} />

  const items = [
    ...nodeItems(nodes, openDetail),
    ...NAV.map((n) => ({ id: `page-${n.id}`, group: T("页面"), icon: n.icon, label: T(n.label), run: () => go(n.id, { animate: false }) })),
    { id: "act-add", group: T("操作"), icon: "plus", label: T("添加节点"), run: () => { go("nodes", { animate: false }); setAdding(true) } },
    { id: "act-register", group: T("操作"), icon: "ticket", label: T("批量注册"), run: () => { go("nodes", { animate: false }); setRegistering(true) } },
    { id: "act-probe", group: T("操作"), icon: "radar", label: T("添加监测"), run: () => go("probes", { animate: false }) },
    { id: "act-backup", group: T("操作"), icon: "download", label: T("下载备份"), run: () => toast(T("备份已开始下载")) },
    { id: "act-theme", group: T("操作"), icon: theme === "dark" ? "sun" : "moon", label: theme === "dark" ? T("切换浅色主题") : T("切换深色主题"), run: () => toggleTheme() },
    { id: "act-public", group: T("操作"), icon: "globe", label: T("打开公开状态页"), run: () => (location.href = "public.html") },
    { id: "act-logout", group: T("操作"), icon: "log-out", label: T("退出登录"), run: () => logout("") },
  ]

  const sidebar = (onNavigate) => (
    <Sidebar route={section} go={go} counts={counts} connected={connected} account={settings.admin_username} onLogout={() => logout("")} onNavigate={onNavigate} tone={tone} beat={tick} site={settings.site_name} />
  )

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main").focus() }}>{T("跳到主要内容")}</a>
      <div className="admin">
        <aside className="sidebar">{sidebar()}</aside>
        <div className="admin-main">
          <header className="admin-top">
            <IconButton className="menu-button" label={T("打开导航")} icon="menu" onClick={() => setMenu(true)} aria-expanded={menu} />
            <div className="admin-title">
              <h1>{title}</h1>
              {subtitle && <span className="admin-subtitle num">{subtitle}</span>}
            </div>
            <div className="topbar-actions">
              <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
                <Icon name="search" />
                <span>{T("搜索或跳转")}</span>
                <Kbd>⌘K</Kbd>
              </button>
              <IconButton className="search-trigger-icon" label={T("搜索或跳转")} icon="search" onClick={() => setPalette(true)} />
              <LangButton />
              <ThemeButton theme={theme} onToggle={toggleTheme} />
            </div>
          </header>
          <main id="main" className="admin-content" tabIndex={-1} data-screen-id={route[0] === "node" ? "node-detail" : section}>
            {page}
          </main>
        </div>
      </div>
      {menu && (
        <Dialog kind="drawer" title={T("导航")} onClose={() => setMenu(false)} className="nav-drawer">
          {sidebar(() => setMenu(false))}
        </Dialog>
      )}
      {inspected && (
        <NodeInspector
          key={inspected.id}
          node={inspected}
          beat={tick}
          initialTab={inspect.tab}
          onClose={() => setInspect(null)}
          onOpen={openDetail}
          onDeleted={(n) => { setInspect(null); if (route[0] === "node") go("nodes"); toast(T("已删除")) }}
        />
      )}
      {adding && <AddNodeFlow beat={tick} onClose={() => setAdding(false)} onOpen={openDetail} />}
      {registering && <RegisterDialog reg={reg} nodes={nodes} beat={tick} onClose={() => setRegistering(false)} />}
      {palette && <Palette items={items} placeholder={T("搜索节点、页面或操作")} onClose={() => setPalette(false)} />}
      <Toasts />
    </>
  )
}

ReactDOM.createRoot(document.getElementById("root")).render(<AdminApp />)
