import { lazy, Suspense, useCallback, useEffect, useState } from "react"

import { T } from "../../shared/i18n.ts"
import { FleetView } from "@/components/Fleet"
import { Globe } from "@/components/Globe"
import { nodeItems, Palette } from "@/components/Palette"
import { Footer, LangButton, ThemeButton } from "@/components/Shell"
import { Brand, fleetTone, Mark, useFavicon } from "@/components/ui/brand"
import { IconButton, Kbd } from "@/components/ui/controls"
import { Empty, Skeleton, toast, Toasts } from "@/components/ui/feedback"
import { Icon } from "@/components/ui/icon"
import { api, useNodes, type Node } from "@/lib/api"
import { transition, useHotkey, useLocale, useTheme } from "@/lib/hooks"

type Me = { authed: boolean; site_name: string; public_page: boolean; public_default_view: "cards" | "list" }

// Split out because the history charts are most of this bundle and the list
// page draws none; the rest is fetched immediately after the list paints.
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

// `/node/{id}` is a real page: it survives a reload, can be linked to, and back
// leaves the detail view rather than the site. The hub serves index.html for any
// unknown path, so no server-side route is required.
function useNodeRoute() {
  const read = () => {
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return match ? Number(match[1]) : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const sync = () => setId(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    id,
    (next: number | null) =>
      transition(() => {
        history.pushState({}, "", next === null ? "/" : `/node/${next}`)
        setId(next)
        scrollTo({ top: 0 })
      }),
  ] as const
}

export default function App() {
  const [theme, toggleTheme] = useTheme()
  const locale = useLocale()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const siteName = me?.site_name?.trim() && me.site_name !== "Monitor" ? me.site_name.trim() : "romi"
  const { nodes, error, closed, tick, connected, retry } = useNodes()
  const [open, go] = useNodeRoute()
  const [view, setView] = useState<"cards" | "list" | null>(null)
  const currentView = view ?? (me?.public_default_view === "list" ? "list" : "cards")
  const [palette, setPalette] = useState(false)

  const loadMe = useCallback(() => {
    // `|| "..."` because an empty message reads as no error: api() falls back to
    // res.statusText, which HTTP/2 and HTTP/3 removed, so a bodiless 502 from a
    // proxy arrives as "". The page would then stay on its loading state and the
    // retry button would never render.
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || T("网络错误")))
  }, [])

  useEffect(() => {
    loadMe()
    // Warmed here rather than left to Suspense, which requests the chunk only
    // once a render reaches the detail view, itself waiting on /me. Without this
    // the split trades its first paint for a full-page skeleton over the first
    // node opened.
    void loadDetail()
  }, [loadMe])

  // The status page was closed while this tab was open. `me` holds whatever it
  // reported at load, so it is re-queried and the page turns to the sign-in
  // notice rather than a list that stopped updating.
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  const sorted = [...(nodes ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.sort - b.sort || a.id - b.id)
  const selected = sorted.find((n) => n.id === open)
  const tone = fleetTone(sorted)
  useFavicon(tone)
  const openNode = (n: Node) => go(n.id)
  useHotkey((e, typing) => !typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")), () => setPalette(true))

  // `/node/{id}` is a page people bookmark and share, so the tab needs the node's
  // name. The site name rather than a fixed string, since the hub lets an operator
  // rename the site.
  useEffect(() => {
    document.title = [selected?.name, siteName].filter(Boolean).join(" · ")
  }, [selected?.name, siteName, locale])

  // The status page is closed and nobody is signed in.
  if (me && !me.public_page && !me.authed)
    return (
      <div className="closed-page">
        <Globe variant="backdrop" theme={theme} />
        <div className="closed-card">
          <Mark size={40} />
          <h1>{T("需要登录")}</h1>
          <p>{T("此站点的状态页未公开，登录后查看节点。")}</p>
          <a className="btn btn-primary" href="/admin/">{T("前往登录")}</a>
        </div>
      </div>
    )

  // Only while there is nothing else to show; once `me` has loaded, a later
  // failure belongs beside the page rather than over it.
  const state = !me ? (meError ? "error" : "loading") : !nodes ? (error ? "error" : "loading") : "ready"
  const reload = () => {
    if (!me) void loadMe()
    retry()
    toast(T("已重新加载"))
  }

  let content
  if (open !== null && me) {
    content = !nodes ? (
      <Skeleton className="hero-skeleton" label={T("正在加载")} />
    ) : selected ? (
      <div className="detail">
        <a className="back-link" href="/" onClick={(e) => { e.preventDefault(); go(null) }}>
          <Icon name="arrow-left" />
          {T("全部节点")}
        </a>
        <Suspense fallback={<Skeleton className="hero-skeleton" label={T("正在加载")} />}>
          <NodeDetail node={selected} authed={me.authed} />
        </Suspense>
      </div>
    ) : (
      <Empty icon="map-pin" title={T("节点不存在")} detail={T("它可能未公开或已被删除。")} action={T("返回全部节点")} onAction={() => go(null)} />
    )
  } else {
    content = (
      <FleetView
        nodes={sorted}
        beat={tick}
        theme={theme}
        onOpen={openNode}
        view={currentView}
        setView={setView}
        state={state}
        error={!me ? meError : error}
        connected={connected}
        onRetry={reload}
      />
    )
  }

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus() }}>{T("跳到主要内容")}</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go(null) }}>
            <Brand name={siteName} tone={tone} beat={connected ? tick : undefined} />
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
            {/* The panel is a separate app built into the hub, not part of
                this page, so this is a navigation rather than a route. */}
            <a className="btn btn-ghost" href="/admin/">{me?.authed ? T("进入后台") : T("登录")}</a>
          </div>
        </div>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        {content}
      </main>
      <Footer nodes={sorted} connected={connected} theme={theme} tone={tone} />
      {palette && <Palette items={nodeItems(sorted, openNode)} onClose={() => setPalette(false)} />}
      <Toasts />
    </>
  )
}
