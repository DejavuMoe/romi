import { setLocale, T } from "../../../shared/i18n.ts"
import type { Node } from "../lib/api"
import { zoneLabel } from "../lib/format"
import { useLocale, type Theme } from "../lib/hooks"
import { DayMap } from "./DayMap"
import { Brand, type Tone } from "./ui/brand"
import { IconButton } from "./ui/controls"

/** Names the other language in that language, the way language menus do. */
export function LangButton() {
  const locale = useLocale()
  const next = locale === "en" ? { code: "zh-CN", name: "中文", mark: "中" } : { code: "en", name: "English", mark: "EN" }
  return (
    <button type="button" className="btn btn-ghost btn-icon lang-button" lang={next.code} aria-label={next.name} data-tip="bottom" onClick={() => setLocale(next.code)}>
      <span className="lang-mark" aria-hidden="true">{next.mark}</span>
      <span className="tip" aria-hidden="true">{next.name}</span>
    </button>
  )
}

export function ThemeButton({ theme, onToggle }: { theme: Theme; onToggle: (event: { currentTarget: EventTarget | null }) => void }) {
  return <IconButton label={theme === "dark" ? T("切换浅色主题") : T("切换深色主题")} icon={theme === "dark" ? "sun" : "moon"} onClick={onToggle} />
}

/** The page ends on the world as it is lit right now. */
export function Footer({ nodes, connected, theme, tone }: { nodes: Node[]; connected: boolean; theme: Theme; tone: Tone }) {
  const regions = new Set(nodes.map((n) => n.country).filter(Boolean)).size
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-meta">
          <span className="brand footer-brand"><Brand tone={tone} version={__ROMI_VERSION__} /></span>
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
