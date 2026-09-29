import { useEffect } from "react"

import { connection } from "../../../../shared/nodes.ts"
import type { Node } from "../../lib/api"
import { percent } from "../../lib/format"

export type Tone = "ok" | "warn" | "bad"

/**
 * The mark: a lowercase r whose shoulder is an orbit, with the probe riding
 * ahead of it. The probe takes the fleet's health and pulses on each push.
 */
export function Mark({ size = 22, tone = "ok", beat }: { size?: number; tone?: Tone; beat?: number }) {
  return (
    <svg className="mark" data-tone={tone} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="mark-r" d="M5.5 20V12A7 7 0 0 1 12.5 5" />
      <circle className="mark-probe" cx="18.3" cy="5" r="2.5" />
      {beat !== undefined && <circle className="mark-beat" key={beat} cx="18.3" cy="5" r="2.5" />}
    </svg>
  )
}

/** Mark and name together; the name is the site's own. */
export function Brand({ name = "romi", tone, beat, size, version }: { name?: string; tone?: Tone; beat?: number; size?: number; version?: string }) {
  return (
    <>
      <Mark tone={tone} beat={beat} size={size} />
      <span className="brand-name">{name}</span>
      {version && <span className="brand-version num">{version}</span>}
    </>
  )
}

/** The fleet's overall tone, for the brand mark and the tab icon. */
export function fleetTone(nodes: Node[]): Tone {
  const statuses = nodes.map((n) => connection(n))
  if (statuses.includes("offline")) return "bad"
  const hot = nodes.some((n) => n.online && n.metrics && (n.metrics.cpu >= 85 || percent(n.metrics.mem_used, n.metrics.mem_total) >= 85 || percent(n.metrics.disk_used, n.metrics.disk_total) >= 85))
  return statuses.includes("reconnecting") || hot ? "warn" : "ok"
}

/**
 * Draws the tab icon: the mark in white on a violet tile, the probe in the
 * fleet's tone once something needs attention.
 */
export function useFavicon(tone: Tone) {
  useEffect(() => {
    const probe = { ok: "#ffffff", warn: "#f5b83d", bad: "#ff5a60" }
    const c = document.createElement("canvas")
    c.width = c.height = 64
    const g = c.getContext("2d")
    if (!g) return
    g.fillStyle = "#5a44ee"
    g.beginPath()
    g.roundRect(0, 0, 64, 64, 16)
    g.fill()
    // The 24-unit mark, drawn at 2.1× about the tile's centre.
    g.setTransform(2.1, 0, 0, 2.1, 32 - 12 * 2.1, 32 - 12 * 2.1)
    g.strokeStyle = "#ffffff"
    g.lineWidth = 3.4
    g.lineCap = "round"
    g.beginPath()
    g.moveTo(5.5, 20)
    g.lineTo(5.5, 12)
    g.arc(12.5, 12, 7, Math.PI, Math.PI * 1.5)
    g.stroke()
    g.fillStyle = probe[tone] || probe.ok
    g.beginPath()
    g.arc(18.3, 5, 2.8, 0, Math.PI * 2)
    g.fill()
    let link = document.querySelector<HTMLLinkElement>("link[rel=icon]")
    if (!link) {
      link = document.createElement("link")
      link.rel = "icon"
      document.head.appendChild(link)
    }
    link.href = c.toDataURL()
  }, [tone])
}
