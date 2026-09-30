import { useState } from "react"
import { T } from "../../../shared/i18n.ts"
import { Brand, type Tone } from "../../../web/src/components/ui/brand"
import { Icon, type IconName } from "../../../web/src/components/ui/icon"
import { IconButton } from "../../../web/src/components/ui/controls"
import { Dialog } from "../../../web/src/components/ui/overlay"

export const SECTIONS = [
  { path: "/admin/nodes", label: "节点", title: "节点", icon: "server" },
  { path: "/admin/ping", label: "监测", title: "监测", icon: "radar" },
  { path: "/admin/notify", label: "通知", title: "通知", icon: "bell" },
  { path: "/admin/data", label: "数据", title: "数据", icon: "database" },
  { path: "/admin/security", label: "安全", title: "安全", icon: "shield" },
  { path: "/admin/settings", label: "设置", title: "设置", icon: "settings" },
] as const satisfies readonly { path: string; label: string; title: string; icon: IconName }[]

type NavigationProps = {
  path: string
  go: (path: string) => void
  siteName: string
  account: string
  count: number
  connected: boolean
  tone: Tone
  beat: number
  onLogout: () => void
}

function Links({ path, go, count }: Pick<NavigationProps, "path" | "go" | "count">) {
  return <nav className="side-nav" aria-label={T("后台导航")}>
    {SECTIONS.map(section => <a key={section.path} href={section.path}
      aria-current={path === section.path || (section.path === "/admin/nodes" && path.startsWith("/admin/node/")) ? "page" : undefined}
      onClick={e => { e.preventDefault(); go(section.path) }}>
      <Icon name={section.icon} /><span>{T(section.label)}</span>
      {section.path === "/admin/nodes" && <span className="nav-count num">{count}</span>}
    </a>)}
  </nav>
}

export function Sidebar(props: NavigationProps) {
  const { siteName, account, connected, tone, beat, onLogout } = props
  return <div className="sidebar-inner">
    <a className="brand" href="/admin/nodes" onClick={e => { e.preventDefault(); props.go("/admin/nodes") }}>
      <Brand name={siteName} tone={tone} beat={connected ? beat : undefined} version={__ROMI_VERSION__} />
    </a>
    <Links {...props} />
    <div className="side-foot">
      <a className="side-link" href="/"><Icon name="globe" /><span>{T("公开状态页")}</span><Icon name="arrow-up-right" className="side-link-go" /></a>
      <div className="side-account">
        <span className="avatar" aria-hidden="true">{account.slice(0, 1).toUpperCase()}</span>
        <span className="side-account-text"><span className="side-account-name">{account}</span>
          <span className="side-live" data-live={connected}><span className="live-dot" />{connected ? T("实时连接") : T("连接中断")}</span>
        </span>
        <IconButton label={T("退出登录")} icon="log-out" onClick={onLogout} tip="top" />
      </div>
    </div>
  </div>
}

export function MobileNavigation(props: NavigationProps) {
  const [open, setOpen] = useState(false)
  return <>
    <IconButton className="menu-button" label={T("打开导航")} icon="menu" onClick={() => setOpen(true)} aria-expanded={open} />
    {open && <Dialog kind="drawer" title={T("导航")} onClose={() => setOpen(false)} className="nav-drawer">
      <Sidebar {...props} go={path => { props.go(path); setOpen(false) }} />
    </Dialog>}
  </>
}
