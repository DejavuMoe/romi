import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

import { countryName, subsolar } from "../../../shared/geo.ts"
import { T } from "../../../shared/i18n.ts"
import { CONNECTION, connection, connectionLabel } from "../../../shared/nodes.ts"
import type { Node } from "../lib/api"
import { createGlobe, fleetCentre, placeGroups, STATUS_RANK, type GlobeEngine, type Group, type Variant } from "../lib/globe"
import { cx } from "../lib/hooks"
import { FlowValue, Region, StatusDot } from "./ui/status"

/**
 * The canvas and its loop. `hero` carries the fleet and its traffic; `detail`
 * faces one node; `backdrop` is a quiet horizon behind sign-in.
 */
export function Globe({ variant = "hero", nodes = [], beat, theme, connected = true, size, lon = 0, lat = 0, active = null, follow = false, onHover, onPick, cardRef }: {
  variant?: Variant
  nodes?: Node[]
  beat?: number
  theme?: string
  connected?: boolean
  size?: number
  lon?: number
  lat?: number
  active?: string | null
  follow?: boolean
  onHover?: (code: string | null) => void
  onPick?: (code: string | null, pointer: string) => void
  cardRef?: RefObject<HTMLDivElement | null>
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef<GlobeEngine | null>(null)
  const handlers = useRef({ onHover, onPick })
  const groups = variant === "backdrop" ? [] : placeGroups(nodes)
  const tilt = Math.max(-40, Math.min(40, lat))
  const start = useRef({ groups, lon, tilt })
  useLayoutEffect(() => {
    handlers.current = { onHover, onPick }
  })

  useLayoutEffect(() => {
    const first = start.current
    const at = variant === "detail" ? { lon: first.lon, lat: first.tilt } : variant === "backdrop" ? { lon: subsolar(new Date()).lon - 64, lat: 12 } : fleetCentre(first.groups)
    const globe = createGlobe(canvas.current!, host.current!, {
      variant,
      lon: at.lon,
      lat: at.lat,
      spin: variant === "hero" ? -4.5 : variant === "backdrop" ? -1.2 : 0,
      onHover: (code) => handlers.current.onHover?.(code),
      onPick: (code, type) => handlers.current.onPick?.(code, type),
      onAnchor: (point) => {
        const el = cardRef?.current
        if (!el) return
        if (!point) {
          el.style.visibility = "hidden"
          return
        }
        const w = el.offsetWidth, h = el.offsetHeight
        const x = point.x + (point.x > point.w * 0.55 ? -w - 18 : 18)
        const y = Math.max(8, Math.min(point.h - h - 8, point.y - h / 2))
        el.style.visibility = "visible"
        el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`
      },
    })
    engine.current = globe
    return () => globe.destroy()
  }, [variant, cardRef])
  useEffect(() => { engine.current?.setGroups(groups) })
  useEffect(() => { engine.current?.restyle() }, [theme])
  useEffect(() => { if (beat !== undefined) engine.current?.beat() }, [beat])
  useEffect(() => { engine.current?.setConnected(connected) }, [connected])
  useEffect(() => { engine.current?.setActive(active, follow) }, [active, follow])
  useEffect(() => { if (variant === "detail") engine.current?.face(lon, tilt) }, [variant, lon, tilt])

  return (
    <div
      ref={host}
      className={cx("globe", `globe-${variant}`)}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
      onDoubleClick={() => variant === "detail" && engine.current?.face(lon, tilt)}
    >
      <canvas ref={canvas}></canvas>
    </div>
  )
}

function GlobeCard({ group, onOpen, pinned, onClose, cardRef, onEnter, onLeave }: {
  group: Group
  onOpen: (node: Node) => void
  pinned: "keyboard" | "pointer" | null
  onClose: () => void
  cardRef: RefObject<HTMLDivElement | null>
  onEnter: () => void
  onLeave: () => void
}) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (pinned === "keyboard") requestAnimationFrame(() => first.current?.focus())
  }, [pinned])
  return (
    <div
      ref={cardRef}
      className={cx("globe-card", pinned && "is-pinned")}
      role={pinned ? "dialog" : undefined}
      aria-label={pinned ? countryName(group.code) : undefined}
      aria-hidden={pinned ? undefined : "true"}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="globe-card-head">
        <Region code={group.code} full />
        {group.nodes.length > 1 && <span className="muted num">{T("{n} 个节点", { n: group.nodes.length })}</span>}
      </div>
      {group.nodes.map((n, i) => {
        const m = n.online ? n.metrics : null
        return (
          <button type="button" key={n.id} ref={i === 0 ? first : undefined} className="globe-card-row" onClick={() => onOpen(n)} tabIndex={pinned ? 0 : -1}>
            <span className="globe-card-name">
              <StatusDot status={connection(n)} />
              <span>{n.name}</span>
            </span>
            <span className="globe-card-stats">
              {m ? (
                <>
                  <span className="num">CPU {m.cpu.toFixed(0)}%</span>
                  <FlowValue dir="down" value={m.net_rx} />
                  <FlowValue dir="up" value={m.net_tx} />
                </>
              ) : (
                <span>{connectionLabel(n)}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The fleet band's globe with its hover card, flow key and the list of places.
 * The list is what a keyboard or a screen reader uses; the globe is the picture.
 */
export function FleetGlobe({ nodes, beat, theme, connected, onOpen }: { nodes: Node[]; beat?: number; theme?: string; connected: boolean; onOpen: (node: Node) => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [pinned, setPinned] = useState<{ code: string; by: string; follow?: boolean } | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const inCard = useRef(false)
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined)
  const groups = placeGroups(nodes)
  const byCode = new Map(groups.map((g) => [g.code, g]))
  const code = [pinned?.code, focus, hover].find((c) => c && byCode.has(c)) || null
  const group = code ? byCode.get(code) : undefined
  const ordered = [...groups].sort((a, b) => b.rx + b.tx - (a.rx + a.tx) || STATUS_RANK[b.status] - STATUS_RANK[a.status])

  useEffect(() => {
    if (!pinned) return
    const close = (e: PointerEvent) => {
      if (!stage.current?.contains(e.target as globalThis.Node)) setPinned(null)
    }
    addEventListener("pointerdown", close)
    return () => removeEventListener("pointerdown", close)
  }, [pinned])
  const unpin = () => {
    const was = pinned
    setPinned(null)
    if (was?.by === "keyboard") stage.current?.querySelector<HTMLElement>(`[data-code="${was.code}"]`)?.focus()
  }
  return (
    <div className="globe-stage" ref={stage}>
      <div className="globe-frame">
        <Globe
          variant="hero"
          nodes={nodes}
          beat={beat}
          theme={theme}
          connected={connected}
          active={code}
          follow={!!code && (code === focus || (pinned?.code === code && !!pinned.follow))}
          cardRef={card}
          onHover={(c) => {
            clearTimeout(clear.current)
            if (c) setHover(c)
            else clear.current = setTimeout(() => !inCard.current && setHover(null), 160)
          }}
          onPick={(c, type) => {
            if (!c) return setPinned(null)
            const g = byCode.get(c)
            if (g && g.nodes.length === 1 && type === "mouse") return onOpen(g.nodes[0])
            setPinned(pinned?.code === c ? null : { code: c, by: type })
          }}
        />
        {group && (
          <GlobeCard
            key={group.code}
            cardRef={card}
            group={group}
            onOpen={onOpen}
            pinned={pinned?.code === group.code ? (pinned.by === "keyboard" ? "keyboard" : "pointer") : null}
            onClose={unpin}
            onEnter={() => { inCard.current = true; clearTimeout(clear.current) }}
            onLeave={() => { inCard.current = false; setHover(null) }}
          />
        )}
        <div className="flow-key" aria-hidden="true">
          <span data-dir="down"><i></i>{T("下载")}</span>
          <span data-dir="up"><i></i>{T("上传")}</span>
        </div>
      </div>
      <ul className="region-list" aria-label={T("节点分布")}>
        {ordered.map((g) => (
          <li key={g.code}>
            <button
              type="button"
              className="region-row"
              data-code={g.code}
              data-status={g.status}
              aria-current={code === g.code ? "true" : undefined}
              aria-label={g.nodes.length > 1 ? T("{name}，{n} 个节点", { name: countryName(g.code), n: g.nodes.length }) : T("{name}，{status}", { name: g.nodes[0].name, status: connectionLabel(g.nodes[0]) })}
              onPointerEnter={(e) => e.pointerType === "mouse" && setFocus(g.code)}
              onPointerLeave={(e) => e.pointerType === "mouse" && setFocus(null)}
              onFocus={() => setFocus(g.code)}
              onBlur={() => setFocus(null)}
              onClick={(e) => {
                if (g.nodes.length === 1) return onOpen(g.nodes[0])
                setPinned({ code: g.code, by: e.detail === 0 ? "keyboard" : "pointer", follow: true })
              }}
            >
              <StatusDot status={g.status} />
              <span className="region-row-name">{countryName(g.code)}</span>
              {g.nodes.length > 1 && <span className="region-row-count num">{g.nodes.length}</span>}
              <span className="region-row-rates">
                {g.online ? (
                  <>
                    <FlowValue dir="down" value={g.rx} />
                    <FlowValue dir="up" value={g.tx} />
                  </>
                ) : (
                  <span className="muted">{T(CONNECTION[g.status])}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
