import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Toaster } from "sonner"
import { T } from "../../shared/i18n.ts"
import { Sidebar, MobileNavigation, SECTIONS } from "@/components/Navigation"
import { Admin } from "@/components/Admin"
import { Login } from "@/components/Login"
import { Nodes } from "@/components/sections/nodes"
import { CreateNode, NodeInspector, RegisterDialog, useRegisterWindow, type InspectTab } from "@/components/sections/node-forms"
import { api, provisioningSite, useNodes, type Node } from "@/lib/api"
import { nodeItems, Palette, type PaletteItem } from "../../web/src/components/Palette"
import { LangButton, ThemeButton } from "../../web/src/components/Shell"
import { fleetTone, useFavicon } from "../../web/src/components/ui/brand"
import { Kbd } from "../../web/src/components/ui/controls"
import { Empty, Notice, Skeleton, Toasts } from "../../web/src/components/ui/feedback"
import { Icon } from "../../web/src/components/ui/icon"
import { useHotkey, useLocale, useTheme } from "../../web/src/lib/hooks"

const NodeDetail = lazy(() => import("../../web/src/components/NodeDetail").then(m => ({ default: m.NodeDetail })))
type Me = { authed: boolean; site_name: string; public_page: boolean; site: string; can_provision: boolean; distribution: { version: string; architecture: string } | null }

function normalise(path: string) {
  return path === "/admin" || path === "/admin/" ? "/admin/nodes" : path.replace(/\/$/, "") || "/admin/nodes"
}
function usePath() {
  const [path, setPath] = useState(() => {
    const start = normalise(location.pathname)
    if (start !== location.pathname) history.replaceState({}, "", start + location.search)
    return start
  })
  useEffect(() => {
    const sync = () => setPath(normalise(location.pathname))
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  const go = useCallback((next: string) => {
    const to = normalise(next)
    history.pushState({}, "", to)
    setPath(to)
    scrollTo({ top: 0 })
  }, [])
  return [path, go] as const
}

export default function App() {
  const [path, go] = usePath()
  const [theme, toggleTheme] = useTheme()
  const locale = useLocale()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const [palette, setPalette] = useState(false)
  const [inspect, setInspect] = useState<{ id: number; tab: InspectTab } | null>(null)
  const [adding, setAdding] = useState(false)
  const [registering, setRegistering] = useState(false)
  const { nodes, admin, error, tick, updated, connected, refresh } = useNodes()
  const reg = useRegisterWindow(!!me?.authed && admin !== false)
  const siteName = me?.site_name?.trim() && me.site_name !== "Monitor" ? me.site_name.trim() : "romi"
  const sorted = [...(nodes ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.sort - b.sort || a.id - b.id)
  const tone = fleetTone(sorted)
  useFavicon(tone)
  const loadMe = useCallback(() => api<Me>("/me")
    .then(next => { setMe(next); setMeError("") })
    .catch((e: Error) => setMeError(e.message || T("网络错误"))), [])
  useEffect(() => { void loadMe() }, [loadMe])
  useEffect(() => { document.title = siteName + " · " + T("管理") }, [siteName, locale])
  useEffect(() => {
    if (me?.authed && admin === false) {
      void loadMe()
    }
  }, [admin, me?.authed, loadMe])
  useHotkey((e, typing) => !!me?.authed && !typing && !document.querySelector('[role="dialog"]') &&
    (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")), () => setPalette(true))

  if (!me) return <div className="closed-page">
    {meError ? <Empty error title={T("加载失败")} detail={T(meError)} action={T("重试")} onAction={loadMe} /> : <Skeleton label={T("正在加载")} className="hero-skeleton" />}
  </div>
  if (!me.authed || admin === false) return <>
    <Login onDone={() => { setInspect(null); setAdding(false); setRegistering(false); setPalette(false); void loadMe(); refresh() }} siteName={siteName} theme={theme} onTheme={toggleTheme} publicOpen={me.public_page} />
    <Toaster position="top-center" theme={theme} /><Toasts />
  </>

  const site = me.site || location.origin
  const canProvision = me.can_provision && !!provisioningSite(location.origin) && !!provisioningSite(site)
  const distributionAvailable = !!me.distribution
  const access = { site, canProvision, distributionAvailable }
  const detailId = Number(path.match(/^\/admin\/node\/(\d+)$/)?.[1] || 0)
  const detail = sorted.find(n => n.id === detailId)
  const section = SECTIONS.find(item => item.path === path) ?? SECTIONS[0]
  const managed = sorted.find(n => n.id === inspect?.id)
  const open = (node: Node) => { setInspect(null); go("/admin/node/" + node.id) }
  const manage = (node: Node) => setInspect({ id: node.id, tab: "overview" })
  const navigate = (next: string) => { setInspect(null); setAdding(false); setRegistering(false); go(next) }
  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {})
    location.assign("/admin/")
  }
  const navigation = { path, go: navigate, siteName, account: String(reg.settings?.admin_username || T("管理员")),
    count: sorted.length, connected, tone, beat: tick, onLogout: signOut }
  const items: PaletteItem[] = [
    ...nodeItems(sorted, open),
    ...SECTIONS.map(item => ({ id: item.path, group: T("页面"), label: T(item.label), icon: item.icon, run: () => navigate(item.path) })),
    ...(canProvision ? [{ id: "add", group: T("操作"), label: T("添加节点"), icon: "plus" as const, run: () => setAdding(true) }] : []),
    ...(canProvision && distributionAvailable ? [{ id: "register", group: T("操作"), label: T("批量注册"), icon: "ticket" as const, run: () => setRegistering(true) }] : []),
    { id: "theme", group: T("操作"), label: theme === "dark" ? T("切换浅色主题") : T("切换深色主题"), icon: theme === "dark" ? "sun" : "moon", run: toggleTheme },
    { id: "logout", group: T("操作"), label: T("退出登录"), icon: "log-out", run: signOut },
  ]
  return <>
    <a className="skip" href="#main" onClick={e => { e.preventDefault(); document.getElementById("main")?.focus() }}>{T("跳到主要内容")}</a>
    <div className="admin">
      <aside className="sidebar"><Sidebar {...navigation} /></aside>
      <div className="admin-main">
        <header className="admin-top">
          <MobileNavigation {...navigation} />
          <div className="admin-title"><h1>{detailId ? detail?.name || T("节点") : T(section.title)}</h1>
            {!detailId && section.path === "/admin/nodes" && <span className="admin-subtitle num">{T("{n} 个节点", { n: sorted.length })} · {T("{n} 在线", { n: sorted.filter(n => n.online).length })}</span>}
          </div>
          <div className="topbar-actions">
            <button type="button" className="search-trigger" onClick={() => setPalette(true)} aria-label={T("搜索或跳转")}>
              <Icon name="search" /><span>{T("搜索或跳转")}</span><Kbd>⌘K</Kbd>
            </button>
            <LangButton /><ThemeButton theme={theme} onToggle={toggleTheme} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="admin-content">
          {error && nodes && <Notice tone="warn">{T(error)}</Notice>}
          {!nodes ? (error ? <Empty error title={T("节点加载失败")} detail={T(error)} action={T("重试")} onAction={refresh} /> : <Skeleton label={T("正在加载节点")} className="hero-skeleton" />) :
            detailId ? (detail ? <Suspense fallback={<Skeleton label={T("正在加载")} className="hero-skeleton" />}>
              <NodeDetail node={detail} beat={tick} admin theme={theme} backLabel={T("节点")} backHref="/admin/nodes" onBack={() => navigate("/admin/nodes")} onManage={manage} threshold={Number(reg.settings?.notify_traffic) || 80} />
            </Suspense> : <Empty title={T("节点不存在")} action={T("返回节点")} onAction={() => navigate("/admin/nodes")} />) :
            section.path === "/admin/nodes" ? <Nodes nodes={sorted} beat={tick} updated={updated} connected={connected} settings={reg.settings} settingsError={reg.error} onRetrySettings={reg.retry} onInspect={manage} onOpen={open} onAdd={() => setAdding(true)} onRegister={() => setRegistering(true)} {...access} /> :
            <Admin path={path} nodes={sorted} refresh={refresh} />}
        </main>
      </div>
    </div>
    {managed && inspect && <NodeInspector key={managed.id} node={managed} beat={tick} initialTab={inspect.tab} onClose={() => setInspect(null)} onOpen={open} onSaved={refresh} onDeleted={() => { setInspect(null); if (detailId === managed.id) navigate("/admin/nodes"); refresh() }} {...access} />}
    {adding && <CreateNode nodes={sorted} beat={tick} onClose={() => setAdding(false)} onOpen={open} onSaved={refresh} {...access} />}
    {registering && <RegisterDialog nodes={sorted} beat={tick} reg={reg} onClose={() => setRegistering(false)} {...access} />}
    {palette && <Palette items={items} placeholder={T("搜索节点、页面或操作")} onClose={() => setPalette(false)} />}
    <Toaster position="top-center" theme={theme} /><Toasts />
  </>
}
