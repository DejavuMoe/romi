import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

import { NodeList } from "@/components/NodeList"
import { NodeCard } from "@/components/NodeCard"
import { Summary } from "@/components/Summary"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, useNodes, type Node } from "@/lib/api"

type Me = { authed: boolean; github: boolean; site_name: string; public_page: boolean; public_default_view: "cards" | "list" }

// Split out because recharts is most of this bundle and the list page draws no
// chart. The landing page is 242 kB rather than 629 kB (77 kB gzipped against
// 188 kB), with the rest fetched immediately after it paints.
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
    (next: number | null) => {
      history.pushState({}, "", next === null ? "/" : `/node/${next}`)
      setId(next)
      scrollTo(0, 0)
    },
  ] as const
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    return saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])
  // Written on the toggle rather than on every render of it: storing the
  // resolved value at mount pins whatever the system preferred at the first
  // visit, and the visitor who never touched the switch stops following their
  // own system from then on.
  return [
    dark,
    () => {
      const next = !dark
      localStorage.setItem("theme", next ? "dark" : "light")
      setDark(next)
    },
  ] as const
}

export default function App() {
  const [dark, toggleTheme] = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const siteName = me?.site_name?.trim() && me.site_name !== "Monitor" ? me.site_name.trim() : "romi"
  const { nodes, error, closed } = useNodes()
  const [open, go] = useNodeRoute()
  const [view, setView] = useState<"cards" | "list" | null>(null)
  const currentView = view ?? (me?.public_default_view === "list" ? "list" : "cards")

  const loadMe = useCallback(() => {
    // `|| "..."` because an empty message reads as no error: api() falls back to
    // res.statusText, which HTTP/2 and HTTP/3 removed, so a bodiless 502 from a
    // proxy arrives as "". The check below would then take the loading branch and
    // the retry button would never render.
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || "网络错误"))
  }, [])

  useEffect(() => {
    loadMe()
    // Warmed here rather than left to Suspense, which requests the chunk only
    // once a render reaches the detail view, itself waiting on /me. Without this
    // the split trades its first paint for a full-page skeleton over the first
    // node opened: 2.6s click-to-chart on 4G against 1.4s unsplit, 1.7s warm.
    void loadDetail()
  }, [loadMe])

  // The status page was closed while this tab was open. `me` holds whatever it
  // reported at load, so it is re-queried; the effect below then directs an
  // anonymous visitor to the panel rather than leaving them on a list that
  // stopped updating with only a red line to explain it.
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  useEffect(() => {
    if (me && !me.public_page && !me.authed) location.href = "/admin/"
  }, [me])

  const sorted = [...(nodes ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.sort - b.sort || a.id - b.id)
  const selected = sorted.find((n) => n.id === open)

  // `/node/{id}` is a page people bookmark and share, so the tab needs the node's
  // name. The site name rather than a fixed string, since the hub lets an operator
  // rename the site.
  useEffect(() => {
    document.title = [selected?.name, siteName].filter(Boolean).join(" · ")
  }, [selected?.name, siteName])

  // Only while there is nothing else to show. Once `me` has loaded, a later
  // failure belongs beside the page rather than over it.
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground">
      {meError ? <div className="space-y-3 text-center"><p role="alert">加载失败：{meError}</p><Button onClick={loadMe}>重试</Button></div> : "加载中…"}
    </div>
  )

  // The status page is closed and nobody is signed in: redirect to the panel.
  if (!me.public_page && !me.authed) return null

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background">
        <div className="app-shell flex min-h-14 items-center gap-2 py-2 sm:gap-3">
          {/* The site name is the way back to the list, so a node page needs
              no back button of its own. */}
          <button className="flex min-w-0 items-baseline gap-3 text-lg font-semibold tracking-tight transition-colors hover:text-primary" onClick={() => go(null)}>
            <span className="site-brand truncate">{siteName}</span>
          </button>
          <div className="flex-1" />
          {/* The panel is a separate app built into the hub, not part of this
              theme, so this is a navigation rather than a route. */}
          <Button variant="ghost" size="sm" asChild>
            <a href="/admin/">
              {me.authed ? "进入后台" : "登录"}
            </a>
          </Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} title={dark ? "切换浅色主题" : "切换深色主题"} aria-label="切换主题">
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="app-shell flex flex-col gap-6 py-7">
        {open === null && <div className="public-heading"><h1>节点状态</h1><span className="text-xs text-muted-foreground">{nodes ? `${nodes.length} 个节点` : "加载中…"}</span></div>}
        {open !== null && <div><Button variant="ghost" size="sm" onClick={() => go(null)}>返回</Button></div>}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {open !== null ? (
          !nodes ? (
            <Skeleton className="h-96" />
          ) : selected ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <NodeDetail node={selected} authed={me?.authed ?? false} />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              节点不存在或未公开。<button className="underline" onClick={() => go(null)}>返回列表</button>
            </p>
          )
        ) : !nodes ? (
          <div className="grid gap-3 md:grid-cols-2 min-[56.25rem]:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        ) : (
          <>
            <Summary nodes={sorted} />
            <div className="public-view-toolbar"><div className="view-switch" role="group" aria-label="显示方式">{([["list", "列表"], ["cards", "卡片"]] as const).map(([value, label]) => <Button key={value} variant="ghost" aria-pressed={currentView === value} onClick={() => setView(value)}>{label}</Button>)}</div></div>
            <div className="public-results">{sorted.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">还没有节点</p>
            ) : currentView === "list" ? <NodeList nodes={sorted} onOpen={go}/> : (
              <div className="public-node-grid">
                {sorted.map((n: Node) => (
                  <NodeCard key={n.id} node={n} onOpen={() => go(n.id)} />
                ))}
              </div>
            )}</div>
          </>
        )}
      </main>
    </div>
  )
}
