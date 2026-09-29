// The fleet on a turning globe, drawn on one canvas. Land is dotted from the
// Natural Earth mask and lit by where the sun is now. A node's traffic runs
// along arcs to and from the places it serves: download inbound, upload
// outbound, livelier the more it moves. The far ends are stand-ins spread over
// the land around the node, not real peers; only the node's own rates drive it.
import { isLand, place, RAD, subsolar, countryName, type Point } from "../../../shared/geo.ts"
import { connection, type Connection } from "../../../shared/nodes.ts"
import type { Node } from "./api"
import { percent } from "./format"
import { reduceMotion } from "./hooks"

const TAU = Math.PI * 2
type Vec = [number, number, number]

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** Unit vector: x east at lon 0, y north, z out of the page at lon 0 / lat 0. */
const vec = (lon: number, lat: number): Vec => {
  const la = lat * RAD, lo = lon * RAD
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]
}
const hashText = (text: string) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// How lively a rate looks, 0–1, on a log scale from 40 KiB/s to 48 MiB/s.
const RATE_LOW = Math.log10(40 * 1024)
const RATE_HIGH = Math.log10(48 * 1024 * 1024)
export const rateLevel = (rate: number) => (rate > 0 ? clamp01((Math.log10(rate) - RATE_LOW) / (RATE_HIGH - RATE_LOW)) : 0)

// ---- land -------------------------------------------------------------------
// Fibonacci points on the sphere, kept where the mask says land. `jitter` nudges
// each point by up to that share of the spacing, which keeps a sparse lattice
// from showing as rows when it is seen close up.
type Dots = { x: Float32Array; y: Float32Array; z: Float32Array; count: number; total: number }
const dotSets: Record<string, Dots> = {}
function landDots(count: number, jitter = 0): Dots {
  const key = `${count}/${jitter}`
  if (dotSets[key]) return dotSets[key]
  const golden = Math.PI * (3 - Math.sqrt(5))
  const step = Math.sqrt((4 * Math.PI) / count) / RAD
  const r = random(hashText("land"))
  const xs: number[] = [], ys: number[] = [], zs: number[] = []
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2
    const theta = golden * i
    let lat = Math.asin(y) / RAD
    let lon = ((Math.atan2(Math.sin(theta), Math.cos(theta)) / RAD + 540) % 360) - 180
    if (jitter) {
      lat = Math.max(-89.9, Math.min(89.9, lat + (r() - 0.5) * 2 * jitter * step))
      lon = ((lon + ((r() - 0.5) * 2 * jitter * step) / Math.max(0.2, Math.cos(lat * RAD)) + 540) % 360) - 180
    }
    if (!isLand(lon, lat)) continue
    const v = vec(lon, lat)
    xs.push(v[0]); ys.push(v[1]); zs.push(v[2])
  }
  return (dotSets[key] = { x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), count: xs.length, total: count })
}

export type Colors = ReturnType<typeof globeColors>

/**
 * The colour of a dot for the sun's elevation there, in 72 shared buckets so a
 * frame is a few dozen fills rather than thousands.
 */
export function dotBucket(el: number) {
  const day = smoothstep(-7, 9, el)
  const dusk = Math.exp(-(((el + 2) / 5.5) ** 2))
  return Math.round(day * 11) * 6 + Math.min(5, Math.round(dusk * 5))
}
export function bucketStyle(key: number, c: Colors) {
  const day = Math.floor(key / 6) / 11
  const dusk = (key % 6) / 5
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  let r = mix(c.night[0], c.day[0], day), g = mix(c.night[1], c.day[1], day), b = mix(c.night[2], c.day[2], day)
  r = mix(r, c.dusk[0], dusk * 0.72); g = mix(g, c.dusk[1], dusk * 0.72); b = mix(b, c.dusk[2], dusk * 0.72)
  const a = mix(c.nightA, c.dayA, day) + dusk * 0.25
  return { fill: `rgba(${r | 0},${g | 0},${b | 0},${Math.min(1, a).toFixed(3)})`, scale: 0.82 + 0.3 * day + 0.25 * dusk }
}
type Light = { order: Uint32Array; runs: { key: number; start: number; end: number }[]; sun: Vec }
// Dots ordered by bucket, so each bucket is one contiguous run.
function lightDots(dots: Dots, sun: Point): Light {
  const s = vec(sun.lon, sun.lat)
  const keys = new Uint8Array(dots.count)
  for (let i = 0; i < dots.count; i++) {
    const d = dots.x[i] * s[0] + dots.y[i] * s[1] + dots.z[i] * s[2]
    keys[i] = dotBucket(Math.asin(Math.max(-1, Math.min(1, d))) / RAD)
  }
  const order = Uint32Array.from({ length: dots.count }, (_, i) => i).sort((a, b) => keys[a] - keys[b])
  const runs: Light["runs"] = []
  for (let i = 0; i < order.length; i++) {
    const k = keys[order[i]]
    if (!runs.length || runs[runs.length - 1].key !== k) runs.push({ key: k, start: i, end: i + 1 })
    else runs[runs.length - 1].end = i + 1
  }
  return { order, runs, sun: s }
}

const GRATICULE = (() => {
  const lines: Float32Array[] = []
  for (const lat of [-60, -30, 0, 30, 60]) {
    const pts: number[] = []
    for (let lon = -180; lon <= 180; lon += 4) pts.push(...vec(lon, lat))
    lines.push(Float32Array.from(pts))
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const pts: number[] = []
    for (let lat = -80; lat <= 80; lat += 4) pts.push(...vec(lon, lat))
    lines.push(Float32Array.from(pts))
  }
  return lines
})()
// Depth bands of the near side, [from, to, opacity]: the rim fades out.
const LIMB: [number, number, number][] = [[0.3, 1.01, 1], [0.14, 0.3, 0.62], [0.01, 0.14, 0.3]]

// ---- flows ------------------------------------------------------------------
function destination(lon: number, lat: number, bearing: number, dist: number): [number, number] {
  const p1 = lat * RAD, l1 = lon * RAD, d = dist * RAD
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearing))
  const l2 = l1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return [((l2 / RAD + 540) % 360) - 180, p2 / RAD]
}
// Stand-in places a node exchanges traffic with: on land, spread around it.
function peersFor(code: string, lon: number, lat: number, count: number, salt: string): Vec[] {
  const r = random(hashText(`${code}/${salt}`))
  const out: Vec[] = []
  for (let slot = 0; slot < count; slot++) {
    for (let tries = 0; tries < 40; tries++) {
      const bearing = ((slot + 0.15 + 0.7 * r()) / count) * TAU
      const [plon, plat] = destination(lon, lat, bearing, 26 + r() * 58)
      if (plat < -54 || plat > 68 || !isLand(plon, plat)) continue
      out.push(vec(plon, plat))
      break
    }
  }
  return out
}
// Great-circle arc from a to b, lifted off the surface in the middle.
const ARC_STEPS = 40
function arcPoints(a: Vec, b: Vec) {
  const w = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
  const sw = Math.sin(w) || 1
  const lift = 0.05 + 0.34 * (w / Math.PI)
  const out = new Float32Array((ARC_STEPS + 1) * 3)
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS
    const k0 = Math.sin((1 - t) * w) / sw, k1 = Math.sin(t * w) / sw
    const h = 1 + lift * Math.sin(Math.PI * t)
    out[i * 3] = (a[0] * k0 + b[0] * k1) * h
    out[i * 3 + 1] = (a[1] * k0 + b[1] * k1) * h
    out[i * 3 + 2] = (a[2] * k0 + b[2] * k1) * h
  }
  return out
}
const PEERS = 5
type Arc = { peer: Vec; pts: Float32Array; alpha: number; t: number; prev: number; pace: number }
type Side = { level: number; target: number; arcs: Arc[] }
type Flow = { v: Vec; rx: Side; tx: Side }
function flowFor(group: Group): Flow {
  const v = vec(group.lon, group.lat)
  const side = (salt: string): Side => {
    const r = random(hashText(`${group.code}/${salt}/phase`))
    return {
      level: 0,
      target: 0,
      arcs: peersFor(group.code, group.lon, group.lat, PEERS, salt).map((peer) => ({ peer, pts: arcPoints(v, peer), alpha: 0, t: r(), prev: 0, pace: 0.85 + 0.3 * r() })),
    }
  }
  return { v, rx: side("rx"), tx: side("tx") }
}

// ---- colours ----------------------------------------------------------------
/** Read from the canvas host, so a globe inside a themed section takes its colours. */
export function globeColors(el: Element) {
  const s = getComputedStyle(el)
  const v = (name: string) => s.getPropertyValue(name).trim()
  const rgb = (name: string) => v(name).split(",").map(Number)
  return {
    day: rgb("--map-day"), night: rgb("--map-night"), dusk: rgb("--map-dusk"),
    dayA: Number(v("--map-day-alpha")) || 0.6, nightA: Number(v("--map-night-alpha")) || 0.4,
    hi: v("--globe-hi"), lo: v("--globe-lo"), rim: v("--globe-rim"), atmo: v("--globe-atmo"), atmoA: Number(v("--globe-atmo-alpha")) || 0.2,
    back: v("--globe-back"), grid: v("--globe-grid"), glow: v("--map-glow"),
    down: v("--flow-down"), up: v("--flow-up"), luminous: v("--flow-glow") === "1",
    ok: v("--ok"), warn: v("--warn"), bad: v("--bad"), surface: v("--surface"), text: v("--text"), text2: v("--text-2"), line: v("--line-2"),
    font: v("--font-sans"),
  }
}
export const STATUS_COLOR: Record<Connection, "ok" | "warn" | "bad" | "line"> = { online: "ok", reconnecting: "warn", offline: "bad", never: "line" }

// ---- groups -------------------------------------------------------------------
export type Group = {
  code: string
  lon: number
  lat: number
  nodes: Node[]
  status: Connection
  hot: boolean
  online: number
  rx: number
  tx: number
}
export const STATUS_RANK: Record<Connection, number> = { offline: 3, reconnecting: 2, online: 1, never: 0 }

/** Nodes that share a country share a place: the hub knows a country, not a city. */
export function placeGroups(nodes: Node[]): Group[] {
  const groups = new Map<string, { code: string; lon: number; lat: number; nodes: Node[] }>()
  for (const n of nodes) {
    const p = place(n.country)
    if (!p) continue
    if (!groups.has(n.country)) groups.set(n.country, { code: n.country, lon: p[0], lat: p[1], nodes: [] })
    groups.get(n.country)!.nodes.push(n)
  }
  return [...groups.values()].map((g) => {
    const live = g.nodes.filter((n) => n.online && n.metrics)
    const status = g.nodes.map((n) => connection(n)).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0]
    const hot = live.some((n) => Math.max(n.metrics!.cpu, percent(n.metrics!.mem_used, n.metrics!.mem_total), percent(n.metrics!.disk_used, n.metrics!.disk_total)) >= 85)
    return {
      ...g, status, hot, online: live.length,
      rx: live.reduce((t, n) => t + n.metrics!.net_rx, 0),
      tx: live.reduce((t, n) => t + n.metrics!.net_tx, 0),
    }
  })
}

/** Where to face first: the middle of the fleet, tilted a little north. */
export function fleetCentre(groups: Group[]) {
  if (!groups.length) return { lon: 100, lat: 18 }
  const s = groups.reduce<Vec>((a, g) => { const v = vec(g.lon, g.lat); return [a[0] + v[0], a[1] + v[1], a[2] + v[2]] }, [0, 0, 0])
  return { lon: Math.atan2(s[0], s[2]) / RAD, lat: Math.max(8, Math.min(30, Math.asin(s[1] / (Math.hypot(...s) || 1)) / RAD)) }
}

// ---- engine -----------------------------------------------------------------
export type Variant = "hero" | "detail" | "backdrop"
export type Anchor = { x: number; y: number; w: number; h: number } | null
export type GlobeOptions = {
  variant: Variant
  lon?: number
  lat?: number
  spin?: number
  onHover?: (code: string | null) => void
  onPick?: (code: string | null, pointer: string) => void
  onAnchor?: (at: Anchor) => void
}
type Pressed = { x: number; y: number; lon: number; lat: number; moved: boolean; t: number; lastLon: number; lastLat: number; type: string }
type Ripple = { v: Vec; dir: "rx" | "tx"; level: number; born: number }

/**
 * One canvas, one animation loop. React hands it the groups and settings; it
 * hands back which group the pointer is on and where the open card should sit.
 */
export function createGlobe(canvas: HTMLCanvasElement, host: HTMLElement, opts: GlobeOptions) {
  const ctx = canvas.getContext("2d")!
  const motion = !reduceMotion()
  const variant = opts.variant
  const S = {
    w: 0, h: 0, dpr: 1, R: 0, cx: 0, cy: 0, dotR: 1,
    lon: opts.lon ?? 0, lat: opts.lat ?? 18, vlon: 0, vlat: 0,
    spin: opts.spin || 0, spinNow: 0, idleUntil: 0,
    groups: [] as Group[], flows: new Map<string, Flow>(), ripples: [] as Ripple[], sides: new Map<string, string>(),
    hover: null as string | null, active: null as string | null, follow: false, pressed: null as Pressed | null,
    connected: true, beatAt: -1e9, colors: null as Colors | null, styles: [] as ReturnType<typeof bucketStyle>[],
    dots: null as Dots | null, light: null as Light | null, lightAt: 0,
    px: null as Float32Array | null, py: null as Float32Array | null, pz: null as Float32Array | null,
    visible: true, frame: 0, last: 0, drawn: 0, dirty: true, destroyed: false, widths: new Map<string, number>(),
  }
  const buf: Vec = [0, 0, 0]

  function restyle() {
    const c = globeColors(host)
    S.colors = c
    S.styles = Array.from({ length: 72 }, (_, k) => bucketStyle(k, c))
    S.widths.clear()
    S.dirty = true
  }
  function relight(now: number) {
    if (!S.dots) return
    S.light = lightDots(S.dots, subsolar(new Date()))
    S.lightAt = now
    S.dirty = true
  }
  function resize() {
    const r = host.getBoundingClientRect()
    S.w = Math.round(r.width)
    S.h = Math.round(r.height)
    if (!S.w || !S.h) return
    S.dpr = variant === "backdrop" ? 1 : Math.min(2, devicePixelRatio || 1)
    canvas.width = S.w * S.dpr
    canvas.height = S.h * S.dpr
    canvas.style.width = `${S.w}px`
    canvas.style.height = `${S.h}px`
    if (variant === "backdrop") {
      S.R = Math.max(S.w, S.h) * 0.72
      S.cx = S.w * 0.5
      S.cy = S.h + S.R * 0.42
    } else {
      S.R = Math.min(S.w, S.h) / 2 / (variant === "hero" ? 1.2 : 1.14)
      S.cx = S.w / 2
      S.cy = S.h / 2
    }
    // About one dot every 5.4 px across the face; coarser for the backdrop.
    const spacing = variant === "backdrop" ? 16 : 5.4
    const wanted = (4 * Math.PI * S.R * S.R) / (spacing * spacing)
    const count = Math.round(Math.max(6000, Math.min(variant === "backdrop" ? 60000 : 24000, wanted)) / 1000) * 1000
    if (!S.dots || S.dots.total !== count) {
      S.dots = landDots(count, variant === "backdrop" ? 0.42 : 0)
      relight(performance.now())
    }
    S.dotR = Math.max(0.9, S.R * Math.sqrt((4 * Math.PI) / count) * (variant === "backdrop" ? 0.18 : 0.24))
    S.dirty = true
  }

  // Rotation to the current view centre.
  let cl = 1, sl = 0, cp = 1, sp = 0
  const turn = () => {
    cl = Math.cos(S.lon * RAD); sl = Math.sin(S.lon * RAD); cp = Math.cos(S.lat * RAD); sp = Math.sin(S.lat * RAD)
  }
  const rot = (x: number, y: number, z: number): Vec => {
    const x1 = x * cl - z * sl, z1 = x * sl + z * cl
    buf[0] = x1
    buf[1] = y * cp - z1 * sp
    buf[2] = y * sp + z1 * cp
    return buf
  }
  // A lifted point shows unless the ball is in front of it.
  const seen = (p: Vec) => p[2] > 0 || p[0] * p[0] + p[1] * p[1] > 1

  function setGroups(groups: Group[]) {
    S.groups = groups
    const codes = new Set(groups.map((g) => g.code))
    for (const g of groups) if (!S.flows.has(g.code)) S.flows.set(g.code, flowFor(g))
    for (const code of [...S.flows.keys()]) if (!codes.has(code)) S.flows.delete(code)
    for (const g of groups) {
      const f = S.flows.get(g.code)!
      const live = S.connected && g.online > 0
      f.rx.target = live ? rateLevel(g.rx) : 0
      f.tx.target = live ? rateLevel(g.tx) : 0
      if (!motion) {
        f.rx.level = f.rx.target
        f.tx.level = f.tx.target
      }
    }
    S.dirty = true
    wake()
  }

  function hit(x: number, y: number, coarse: boolean) {
    turn()
    let best: string | null = null, dist = coarse ? 26 : 16
    for (const g of S.groups) {
      const p = rot(...vec(g.lon, g.lat))
      if (p[2] < 0.08) continue
      const d = Math.hypot(S.cx + S.R * p[0] - x, S.cy - S.R * p[1] - y)
      if (d < dist) { dist = d; best = g.code }
    }
    return best
  }

  // ---- drawing ----
  function drawSphere(c: Colors) {
    const { cx, cy, R } = S
    const [sx, sy, sz] = S.light ? [...rot(...S.light.sun)] : [0.4, 0.4, 0.8]
    // Air: a soft ring, warmer on the side the sun is on.
    const air = ctx.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.2)
    air.addColorStop(0, `rgba(${c.atmo},${c.atmoA})`)
    air.addColorStop(1, `rgba(${c.atmo},0)`)
    ctx.fillStyle = air
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.2, 0, TAU); ctx.fill()
    const lx = cx + sx * R * 0.9, ly = cy - sy * R * 0.9
    const warm = ctx.createRadialGradient(lx, ly, 0, lx, ly, R * 0.9)
    warm.addColorStop(0, `rgba(${c.glow},${(0.26 * clamp01(0.4 + sz)).toFixed(3)})`)
    warm.addColorStop(1, `rgba(${c.glow},0)`)
    ctx.fillStyle = warm
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.16, 0, TAU); ctx.fill()
    // The ball, brightest toward the sun.
    const ball = ctx.createRadialGradient(cx + sx * R * 0.45, cy - sy * R * 0.45, R * 0.05, cx, cy, R * 1.02)
    ball.addColorStop(0, c.hi)
    ball.addColorStop(1, c.lo)
    ctx.fillStyle = ball
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill()
  }

  function drawLand(c: Colors) {
    const { cx, cy, R, dots, light, h } = S
    if (!dots || !light) return
    const n = dots.count
    if (!S.px || S.px.length !== n) {
      S.px = new Float32Array(n); S.py = new Float32Array(n); S.pz = new Float32Array(n)
    }
    const px = S.px, py = S.py!, pz = S.pz!
    for (let i = 0; i < n; i++) {
      const p = rot(dots.x[i], dots.y[i], dots.z[i])
      px[i] = cx + R * p[0]; py[i] = cy - R * p[1]; pz[i] = p[2]
    }
    // The far side, faint through the ball.
    if (variant !== "backdrop") {
      ctx.fillStyle = c.back
      ctx.beginPath()
      const r = S.dotR * 0.8
      for (let i = 0; i < n; i++) if (pz[i] < -0.05) ctx.rect(px[i] - r / 2, py[i] - r / 2, r, r)
      ctx.fill()
    }
    // Lines of latitude and longitude on the near side.
    ctx.strokeStyle = c.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const line of GRATICULE) {
      let open = false
      for (let i = 0; i < line.length; i += 3) {
        const p = rot(line[i], line[i + 1], line[i + 2])
        if (p[2] <= 0) { open = false; continue }
        const x = cx + R * p[0], y = cy - R * p[1]
        if (open) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
        open = true
      }
    }
    ctx.stroke()
    // The near side, lit by the sun, smaller and fainter toward the edge so the
    // crowded rows at the rim do not beat against each other.
    for (const [lo, hi, alpha] of LIMB) {
      ctx.globalAlpha = alpha
      for (const run of light.runs) {
        const style = S.styles[run.key]
        ctx.fillStyle = style.fill
        ctx.beginPath()
        for (let k = run.start; k < run.end; k++) {
          const i = light.order[k]
          const z = pz[i]
          if (z <= lo || z > hi || py[i] < -4 || py[i] > h + 4) continue
          const r = S.dotR * style.scale * (0.35 + 0.65 * z)
          ctx.moveTo(px[i] + r, py[i])
          ctx.arc(px[i], py[i], r, 0, TAU)
        }
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  // A point part-way along an arc, on screen, with whether it shows.
  const along = (pts: Float32Array, u: number, out: number[]) => {
    const f = Math.max(0, Math.min(ARC_STEPS, u * ARC_STEPS))
    const i = Math.min(ARC_STEPS - 1, Math.floor(f)), t = f - i
    const a = i * 3, b = a + 3
    const p = rot(pts[a] + (pts[b] - pts[a]) * t, pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t, pts[a + 2] + (pts[b + 2] - pts[a + 2]) * t)
    out[0] = S.cx + S.R * p[0]; out[1] = S.cy - S.R * p[1]; out[2] = seen(p) ? 1 : 0
    return out
  }

  function drawFlows(c: Colors, now: number, dt: number) {
    const { cx, cy, R } = S
    const pt = [0, 0, 0], prev = [0, 0, 0]
    ctx.lineCap = "round"
    for (const g of S.groups) {
      const f = S.flows.get(g.code)
      if (!f) continue
      const emphasis = S.active && S.active !== g.code ? 0.3 : 1
      for (const dir of ["rx", "tx"] as const) {
        const side = f[dir]
        const color = dir === "rx" ? c.down : c.up
        side.level += (side.target - side.level) * Math.min(1, dt * 1.8)
        const L = side.level
        const on = L > 0.015 ? 1 + Math.round(L * (side.arcs.length - 1)) : 0
        const speed = 0.16 + 0.9 * L
        const particles = 1 + Math.round(L * 3)
        const tail = 0.08 + 0.16 * L
        const head = 1.3 + 2.2 * L
        side.arcs.forEach((arc, index) => {
          arc.alpha += ((index < on ? 1 : 0) - arc.alpha) * Math.min(1, dt * 1.4)
          if (arc.alpha < 0.01) return
          const a = arc.alpha * emphasis
          // The route.
          ctx.strokeStyle = color
          ctx.globalAlpha = a * (0.12 + 0.22 * L)
          ctx.lineWidth = 0.8 + 1.1 * L
          ctx.beginPath()
          let open = false
          for (let i = 0; i <= ARC_STEPS; i++) {
            const p = rot(arc.pts[i * 3], arc.pts[i * 3 + 1], arc.pts[i * 3 + 2])
            if (!seen(p)) { open = false; continue }
            const x = cx + R * p[0], y = cy - R * p[1]
            if (open) ctx.lineTo(x, y)
            else ctx.moveTo(x, y)
            open = true
          }
          ctx.stroke()
          // The far end, when that side of the world faces us.
          const end = rot(...arc.peer)
          if (end[2] > 0.05) {
            ctx.globalAlpha = a * 0.4 * smoothstep(0.05, 0.3, end[2])
            ctx.fillStyle = color
            ctx.beginPath(); ctx.arc(cx + R * end[0], cy - R * end[1], 1.2 + 0.6 * L, 0, TAU); ctx.fill()
          }
          if (!motion) return
          arc.prev = arc.t
          arc.t += dt * speed * arc.pace
          for (let k = 0; k < particles; k++) {
            const off = k / particles
            const at = (arc.t + off) % 1
            if (Math.floor(arc.prev + off) !== Math.floor(arc.t + off)) arrive(dir === "rx" ? f.v : arc.peer, dir, L, now)
            // Download travels peer → node, upload node → peer.
            const u = dir === "rx" ? 1 - at : at
            const from = dir === "rx" ? u + tail : u - tail
            const STEPS = 8
            along(arc.pts, from, prev)
            for (let s = 1; s <= STEPS; s++) {
              along(arc.pts, from + ((u - from) * s) / STEPS, pt)
              if (pt[2] && prev[2]) {
                const q = s / STEPS
                ctx.globalAlpha = a * q * q * 0.95
                ctx.lineWidth = head * (0.35 + 0.75 * q)
                ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(pt[0], pt[1]); ctx.stroke()
              }
              prev[0] = pt[0]; prev[1] = pt[1]; prev[2] = pt[2]
            }
            if (pt[2]) {
              // On a dark globe the head burns white inside its colour; on a
              // light one it is simply the colour, a little larger.
              if (c.luminous) {
                ctx.globalAlpha = a * (0.14 + 0.16 * L)
                ctx.fillStyle = color
                ctx.beginPath(); ctx.arc(pt[0], pt[1], head * 2.2, 0, TAU); ctx.fill()
                ctx.globalAlpha = a
                ctx.fillStyle = "#ffffff"
                ctx.beginPath(); ctx.arc(pt[0], pt[1], head * 0.55, 0, TAU); ctx.fill()
              } else {
                ctx.globalAlpha = a
                ctx.fillStyle = color
                ctx.beginPath(); ctx.arc(pt[0], pt[1], head * 0.75, 0, TAU); ctx.fill()
              }
            }
          }
        })
      }
    }
    ctx.globalAlpha = 1
  }

  function arrive(v: Vec, dir: "rx" | "tx", level: number, now: number) {
    if (S.ripples.length > 48) S.ripples.shift()
    S.ripples.push({ v, dir, level, born: now })
  }
  function drawRipples(c: Colors, now: number) {
    S.ripples = S.ripples.filter((r) => now - r.born < 900)
    for (const r of S.ripples) {
      const p = rot(...r.v)
      if (p[2] < 0.05) continue
      const q = (now - r.born) / 900
      const home = r.dir === "rx"
      ctx.strokeStyle = home ? c.down : c.up
      ctx.globalAlpha = (1 - q) * (home ? 0.3 + 0.45 * r.level : 0.25) * smoothstep(0.05, 0.3, p[2])
      ctx.lineWidth = home ? 1 + r.level : 1
      ctx.beginPath()
      ctx.arc(S.cx + S.R * p[0], S.cy - S.R * p[1], 2 + q * (home ? 6 + 12 * r.level : 5), 0, TAU)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  const width = (text: string) => {
    if (!S.widths.has(text)) S.widths.set(text, ctx.measureText(text).width)
    return S.widths.get(text)!
  }
  function drawMarkers(c: Colors, now: number) {
    type Box = { x: number; y: number; w: number; h: number }
    const placed: Box[] = []
    const spots: { g: Group; x: number; y: number; z: number; active: boolean }[] = []
    for (const g of S.groups) {
      const p = rot(...vec(g.lon, g.lat))
      if (p[2] < 0.02) continue
      const x = S.cx + S.R * p[0], y = S.cy - S.R * p[1], z = p[2]
      const fade = smoothstep(0.02, 0.2, z) * (S.connected ? 1 : 0.6)
      const active = g.code === S.active
      const color = c[STATUS_COLOR[g.status]] || c.ok
      const f = S.flows.get(g.code)
      const L = f ? Math.max(f.rx.level, f.tx.level) : 0
      const size = (variant === "detail" ? 4 : 4.5) * (0.7 + 0.3 * z) * (active ? 1.25 : 1)
      // Halo, wider with more traffic.
      const reach = size * (3 + 3 * L)
      const halo = ctx.createRadialGradient(x, y, 0, x, y, reach)
      halo.addColorStop(0, color)
      halo.addColorStop(1, "transparent")
      ctx.globalAlpha = fade * (0.26 + 0.2 * L)
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(x, y, reach, 0, TAU); ctx.fill()
      // A push just arrived.
      const since = now - S.beatAt
      if (motion && g.status === "online" && since < 1600) {
        const q = since / 1600
        ctx.strokeStyle = color
        ctx.globalAlpha = fade * (1 - q) * 0.7
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(x, y, size + q * 16, 0, TAU); ctx.stroke()
      }
      ctx.globalAlpha = fade
      if (g.hot) {
        ctx.strokeStyle = c.bad
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(x, y, size + 4, 0, TAU); ctx.stroke()
      }
      if (active) {
        ctx.strokeStyle = c.text
        ctx.globalAlpha = fade * 0.5
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(x, y, size + 8, 0, TAU); ctx.stroke()
      }
      const blink = g.status === "reconnecting" && motion ? 0.55 + 0.45 * Math.cos(now / 220) : 1
      ctx.globalAlpha = fade * blink
      ctx.fillStyle = g.status === "offline" ? c.surface : color
      ctx.strokeStyle = g.status === "offline" ? color : c.surface
      ctx.lineWidth = g.status === "offline" ? 2.5 : 2
      ctx.beginPath(); ctx.arc(x, y, size, 0, TAU); ctx.fill(); ctx.stroke()
      ctx.globalAlpha = 1
      spots.push({ g, x, y, z, active })
      placed.push({ x: x - 10, y: y - 10, w: 20, h: 20 })
    }
    const all = variant === "hero" && S.R >= 150
    if (!all && !S.active) return
    ctx.font = `500 12px ${c.font}`
    ctx.textBaseline = "middle"
    const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (const { g, x, y, z, active } of spots.sort((a, b) => Number(b.active) - Number(a.active))) {
      if (!active && (!all || z < 0.18)) continue
      const name = countryName(g.code)
      const count = g.nodes.length > 1 ? String(g.nodes.length) : ""
      const w = 16 + width(name) + (count ? width(count) + 14 : 0)
      const h = 22
      const choices: Record<string, { x: number; y: number }> = {
        right: { x: x + 12, y: y - h / 2 },
        left: { x: x - 12 - w, y: y - h / 2 },
        above: { x: x - w / 2, y: y - 14 - h },
        below: { x: x - w / 2, y: y + 14 },
      }
      const fits = (side: string) => {
        const b = { ...choices[side], w, h }
        return b.x > 2 && b.y > 2 && b.x + w < S.w - 2 && b.y + h < S.h - 2 && !placed.some((o) => overlaps(o, b))
      }
      const last = S.sides.get(g.code)
      const side = last && fits(last) ? last : ["right", "left", "above", "below"].find(fits)
      if (!side) continue
      S.sides.set(g.code, side)
      const b = { ...choices[side], w, h }
      placed.push(b)
      ctx.globalAlpha = active ? 1 : smoothstep(0.18, 0.4, z)
      ctx.fillStyle = c.surface
      ctx.strokeStyle = c.line
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(b.x, b.y, w, h, h / 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = active ? c.text : c.text2
      ctx.fillText(name, b.x + 8, b.y + h / 2 + 0.5)
      if (count) {
        const bx = b.x + 8 + width(name) + 6
        ctx.fillStyle = c[STATUS_COLOR[g.status]] || c.ok
        ctx.beginPath(); ctx.roundRect(bx, b.y + 4, width(count) + 8, h - 8, (h - 8) / 2); ctx.fill()
        ctx.fillStyle = c.surface
        ctx.fillText(count, bx + 4, b.y + h / 2 + 0.5)
      }
      ctx.globalAlpha = 1
    }
  }

  function render(now: number, dt: number) {
    const c = S.colors!
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0)
    ctx.clearRect(0, 0, S.w, S.h)
    turn()
    drawSphere(c)
    drawLand(c)
    if (variant !== "backdrop") {
      drawFlows(c, now, dt)
      drawRipples(c, now)
      drawMarkers(c, now)
    }
    ctx.strokeStyle = c.rim
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(S.cx, S.cy, S.R + 0.5, 0, TAU); ctx.stroke()
    if (opts.onAnchor) {
      const g = S.active && S.groups.find((x) => x.code === S.active)
      const p = g ? rot(...vec(g.lon, g.lat)) : null
      opts.onAnchor(p && p[2] > 0.02 ? { x: S.cx + S.R * p[0], y: S.cy - S.R * p[1], w: S.w, h: S.h } : null)
    }
  }

  function step(now: number) {
    S.frame = 0
    if (S.destroyed) return
    const dt = Math.min(0.05, (now - (S.last || now)) / 1000)
    S.last = now
    if (now - S.lightAt > 60000) relight(now)
    // Where the view is heading: a followed place, else the idle spin.
    const hold = S.pressed || S.hover || S.active || now < S.idleUntil
    S.spinNow += ((hold || !motion ? 0 : S.spin) - S.spinNow) * Math.min(1, dt * 2.5)
    const g = S.follow && S.active ? S.groups.find((x) => x.code === S.active) : undefined
    if (g) {
      const dl = ((((g.lon - S.lon) % 360) + 540) % 360) - 180
      const tl = Math.max(-40, Math.min(40, g.lat * 0.85))
      const k = motion ? Math.min(1, dt * 4) : 1
      S.lon += dl * k
      S.lat += (tl - S.lat) * k
      S.vlon = S.vlat = 0
    } else if (!S.pressed) {
      S.lon += (S.spinNow + S.vlon) * dt
      S.lat = Math.max(-60, Math.min(60, S.lat + S.vlat * dt))
      const decay = Math.exp(-dt * 2.6)
      S.vlon *= decay
      S.vlat *= decay
    }
    S.lon = ((((S.lon + 180) % 360) + 360) % 360) - 180
    const moving = motion && (Math.abs(S.spinNow) > 0.01 || Math.abs(S.vlon) > 0.05 || Math.abs(S.vlat) > 0.05 || !!g || S.groups.length > 0 || S.ripples.length > 0)
    // The backdrop is decoration: a lower frame rate is plenty.
    const due = variant !== "backdrop" || now - S.drawn > 40
    if ((S.dirty || moving || S.pressed) && due && S.w && S.colors) {
      render(now, dt)
      S.drawn = now
      S.dirty = false
    }
    if (S.visible && (moving || S.dirty)) S.frame = requestAnimationFrame(step)
    else S.last = 0
  }
  function wake() {
    if (!S.frame && S.visible && !S.destroyed) S.frame = requestAnimationFrame(step)
  }

  // ---- pointer ----
  const local = (e: PointerEvent): [number, number] => {
    const r = host.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  function setHover(code: string | null) {
    if (code === S.hover) return
    S.hover = code
    host.style.cursor = code ? "pointer" : ""
    opts.onHover?.(code)
    S.dirty = true
    wake()
  }
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || variant === "backdrop") return
    const [x, y] = local(e)
    S.pressed = { x, y, lon: S.lon, lat: S.lat, moved: false, t: performance.now(), lastLon: S.lon, lastLat: S.lat, type: e.pointerType }
    wake()
  }
  const onMove = (e: PointerEvent) => {
    const [x, y] = local(e)
    const P = S.pressed
    if (P) {
      const dx = x - P.x, dy = y - P.y
      if (!P.moved && Math.hypot(dx, dy) > 4) {
        P.moved = true
        S.follow = false
        host.setPointerCapture?.(e.pointerId)
        host.classList.add("is-dragging")
        setHover(null)
      }
      if (P.moved) {
        const k = 57.3 / S.R
        const now = performance.now()
        const lon = P.lon - dx * k
        const lat = Math.max(-60, Math.min(60, P.lat + dy * k))
        const dt = Math.max(0.008, (now - P.t) / 1000)
        S.vlon = S.vlon * 0.5 + ((lon - P.lastLon) / dt) * 0.5
        S.vlat = S.vlat * 0.5 + ((lat - P.lastLat) / dt) * 0.5
        P.lastLon = S.lon = lon
        P.lastLat = S.lat = lat
        P.t = now
        S.dirty = true
      }
      return
    }
    if (variant === "hero") setHover(hit(x, y, e.pointerType !== "mouse"))
  }
  const onUp = (e: PointerEvent) => {
    const P = S.pressed
    S.pressed = null
    host.classList.remove("is-dragging")
    if (!P) return
    if (P.moved) {
      S.idleUntil = performance.now() + 2600
      if (!motion) S.vlon = S.vlat = 0
      wake()
      return
    }
    if (variant !== "hero" || e.type === "pointercancel") return
    const [x, y] = local(e)
    opts.onPick?.(hit(x, y, P.type !== "mouse"), P.type)
  }
  const onLeave = () => {
    if (!S.pressed) setHover(null)
  }
  host.addEventListener("pointerdown", onDown)
  host.addEventListener("pointermove", onMove)
  host.addEventListener("pointerup", onUp)
  host.addEventListener("pointercancel", onUp)
  host.addEventListener("pointerleave", onLeave)

  const ro = new ResizeObserver(() => { resize(); wake() })
  ro.observe(host)
  const io = new IntersectionObserver(([entry]) => {
    S.visible = entry.isIntersecting && !document.hidden
    if (S.visible) { S.dirty = true; wake() }
  })
  io.observe(host)
  const onVisibility = () => {
    S.visible = !document.hidden
    if (S.visible) { S.dirty = true; wake() }
  }
  document.addEventListener("visibilitychange", onVisibility)
  restyle()
  resize()
  wake()

  return {
    setGroups,
    restyle() { restyle(); wake() },
    beat() { S.beatAt = performance.now(); wake() },
    setConnected(value: boolean) {
      S.connected = value
      setGroups(S.groups)
    },
    /** The group whose card is open; `follow` turns the globe to face it. */
    setActive(code: string | null, follow: boolean) {
      if (!code && S.active) S.idleUntil = performance.now() + 1200
      S.active = code
      S.follow = follow
      S.dirty = true
      wake()
    },
    face(lon: number, lat: number) {
      Object.assign(S, { lon, lat, vlon: 0, vlat: 0, dirty: true })
      wake()
    },
    destroy() {
      S.destroyed = true
      cancelAnimationFrame(S.frame)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      host.removeEventListener("pointerdown", onDown)
      host.removeEventListener("pointermove", onMove)
      host.removeEventListener("pointerup", onUp)
      host.removeEventListener("pointercancel", onUp)
      host.removeEventListener("pointerleave", onLeave)
    },
  }
}

export type GlobeEngine = ReturnType<typeof createGlobe>
