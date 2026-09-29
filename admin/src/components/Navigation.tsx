import { useState } from "react"
import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

export const SECTIONS = [
  { path: "/admin/nodes", label: "节点", title: "节点管理" },
  { path: "/admin/ping", label: "监测", title: "监测" },
  { path: "/admin/notify", label: "通知", title: "通知" },
  { path: "/admin/data", label: "数据", title: "数据" },
  { path: "/admin/security", label: "安全", title: "安全" },
  { path: "/admin/settings", label: "设置", title: "站点设置" },
] as const

type NavigationProps = { path: string; go: (path: string) => void }

function Links({ path, go }: NavigationProps) {
  return <nav className="admin-nav" aria-label="后台导航">
    {SECTIONS.map((section, index) => <Button key={section.path} variant="ghost"
      aria-current={path === section.path ? "page" : undefined} onClick={() => go(section.path)}>
      <span aria-hidden="true" className="nav-number">{String(index + 1).padStart(2, "0")}</span>
      {section.label}
    </Button>)}
  </nav>
}

export function Sidebar({ siteName, ...props }: NavigationProps & { siteName: string }) {
  return <aside className="admin-sidebar">
    <a href="/" className="site-brand">{siteName}</a>
    <Links {...props} />
    <a className="sidebar-public-link" href="/">公开状态页</a>
  </aside>
}

export function MobileNavigation({ path, go }: NavigationProps) {
  const [open, setOpen] = useState(false)
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button className="mobile-navigation-trigger" variant="ghost" size="icon" aria-label="打开导航"><Menu /></Button></DialogTrigger>
    <DialogContent className="admin-navigation-dialog top-0 left-0 translate-x-0 translate-y-0">
      <DialogHeader><DialogTitle>导航</DialogTitle></DialogHeader>
      <Links path={path} go={(next) => { go(next); setOpen(false) }} />
      <a href="/">公开状态页</a>
    </DialogContent>
  </Dialog>
}
