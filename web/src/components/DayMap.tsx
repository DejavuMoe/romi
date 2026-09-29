import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { elevation, isLand, subsolar } from "../../../shared/geo.ts"
import type { Node } from "../lib/api"
import { bucketStyle, dotBucket, globeColors, placeGroups, smoothstep, STATUS_COLOR } from "../lib/globe"
import { useWidth } from "../lib/hooks"

const MAP_NORTH = 76, MAP_SOUTH = -58

/**
 * [r, g, b, alpha] from a colour token. The stylesheet minifier writes
 * `rgba(255, 236, 200, 0.7)` as `#ffecc8b3`, so both spellings are read.
 */
function rgba(value: string): number[] {
  const text = value.trim()
  const hex = text.match(/^#([\da-f]{3,8})$/i)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex
    const [r, g, b, a = 255] = full.match(/../g)!.map((pair) => parseInt(pair, 16))
    return [r, g, b, a / 255]
  }
  const [r = 0, g = 0, b = 0, a = 1] = (text.match(/[\d.]+/g) || []).map(Number)
  return text ? [r, g, b, a] : [0, 0, 0, 0]
}

/**
 * The whole world flat, as the globe's dots: land lit by where the sun stands
 * now, the nodes at their places in their status colours. It redraws once a
 * minute, which is as fast as the terminator visibly moves at this size.
 */
export function DayMap({ nodes, theme, label }: { nodes: Node[]; theme?: string; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const width = useWidth(host)
  const height = Math.round((width * (MAP_NORTH - MAP_SOUTH)) / 360)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])
  const groups = placeGroups(nodes)
  const key = groups.map((g) => `${g.code}:${g.status}`).join()
  const latest = useRef(groups)
  useLayoutEffect(() => {
    latest.current = groups
  })
  useLayoutEffect(() => {
    const c = canvas.current
    const el = host.current
    if (!c || !el || !width) return
    const dpr = Math.min(2, devicePixelRatio || 1)
    c.width = width * dpr
    c.height = height * dpr
    const g = c.getContext("2d")
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    const style = getComputedStyle(el)
    const colors = globeColors(el)
    const bg = style.getPropertyValue("--bg").trim()
    const sun = subsolar(new Date(now))
    const x = (lon: number) => ((lon + 180) / 360) * width
    const y = (lat: number) => ((MAP_NORTH - lat) / (MAP_NORTH - MAP_SOUTH)) * height
    // A square grid of about 3° cells, each land cell one dot.
    const cols = 120
    const cell = width / cols
    const rows = Math.round(height / cell)
    // Day and night shading, one pixel per cell, scaled up smooth and faded out
    // towards the edges so the map has no frame.
    const rgbaOf = (name: string) => rgba(style.getPropertyValue(name))
    const night = rgbaOf("--map-shade-night"), day = rgbaOf("--map-shade-day")
    const small = document.createElement("canvas")
    small.width = cols
    small.height = rows
    const sc = small.getContext("2d")!
    const px = sc.createImageData(cols, rows)
    for (let r = 0; r < rows; r++) {
      const lat = MAP_NORTH - ((r + 0.5) / rows) * (MAP_NORTH - MAP_SOUTH)
      for (let q = 0; q < cols; q++) {
        const t = smoothstep(-12, 55, elevation(-180 + ((q + 0.5) / cols) * 360, lat, sun))
        // Mixed with premultiplied alpha, so twilight is not a grey seam.
        const o = (r * cols + q) * 4
        const a = night[3] + (day[3] - night[3]) * t
        for (let i = 0; i < 3; i++) px.data[o + i] = a ? (night[i] * night[3] + (day[i] * day[3] - night[i] * night[3]) * t) / a : 0
        px.data[o + 3] = 255 * a
      }
    }
    sc.putImageData(px, 0, 0)
    const shade = document.createElement("canvas")
    shade.width = c.width
    shade.height = c.height
    const sg = shade.getContext("2d")!
    sg.imageSmoothingEnabled = true
    sg.drawImage(small, 0, 0, shade.width, shade.height)
    sg.globalCompositeOperation = "destination-in"
    for (const [x1, y1] of [[shade.width, 0], [0, shade.height]]) {
      const fade = sg.createLinearGradient(0, 0, x1, y1)
      fade.addColorStop(0, "rgba(0,0,0,0)")
      fade.addColorStop(0.08, "rgba(0,0,0,1)")
      fade.addColorStop(0.92, "rgba(0,0,0,1)")
      fade.addColorStop(1, "rgba(0,0,0,0)")
      sg.fillStyle = fade
      sg.fillRect(0, 0, shade.width, shade.height)
    }
    g.drawImage(shade, 0, 0, width, height)
    const styles: Record<number, ReturnType<typeof bucketStyle>> = {}
    for (let r = 0; r < rows; r++) {
      const lat = MAP_NORTH - ((r + 0.5) / rows) * (MAP_NORTH - MAP_SOUTH)
      for (let q = 0; q < cols; q++) {
        const lon = -180 + ((q + 0.5) / cols) * 360
        if (!isLand(lon, lat)) continue
        const k = dotBucket(elevation(lon, lat, sun))
        const s = (styles[k] ||= bucketStyle(k, colors))
        g.fillStyle = s.fill
        g.beginPath()
        g.arc((q + 0.5) * cell, (r + 0.5) * cell, cell * 0.3 * s.scale, 0, Math.PI * 2)
        g.fill()
      }
    }
    // The sun, where it stands overhead.
    const sx = x(sun.lon), sy = y(sun.lat)
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, cell * 5)
    glow.addColorStop(0, `rgba(${colors.glow}, 0.55)`)
    glow.addColorStop(1, `rgba(${colors.glow}, 0)`)
    g.fillStyle = glow
    g.beginPath(); g.arc(sx, sy, cell * 5, 0, Math.PI * 2); g.fill()
    g.fillStyle = `rgb(${style.getPropertyValue("--map-sun").trim()})`
    g.beginPath(); g.arc(sx, sy, cell * 0.9, 0, Math.PI * 2); g.fill()
    // Nodes over the land: a ring of page colour keeps each one legible.
    for (const p of latest.current) {
      const nx = x(p.lon), ny = y(p.lat)
      const tone = colors[STATUS_COLOR[p.status]] || colors.line
      g.fillStyle = bg
      g.beginPath(); g.arc(nx, ny, cell * 1.25, 0, Math.PI * 2); g.fill()
      g.fillStyle = tone
      g.beginPath(); g.arc(nx, ny, cell * 0.8, 0, Math.PI * 2); g.fill()
    }
  }, [width, height, now, theme, key])
  return (
    <div ref={host} className="day-map">
      <canvas ref={canvas} style={{ width: "100%", height }} role="img" aria-label={label}></canvas>
    </div>
  )
}
