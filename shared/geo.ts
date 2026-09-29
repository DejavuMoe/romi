// Geography, computed in the browser: where each country sits, where the sun
// is, and the land mask the globe and the day map draw from.
import { intl } from "./i18n.ts"
import { LAND } from "./land.ts"

export const RAD = Math.PI / 180

// Land cells decoded once into a byte per cell.
const mask = (() => {
  const { step, rows } = LAND
  const cols = 360 / step
  const lines = rows.split("|")
  const cells = new Uint8Array(cols * lines.length)
  lines.forEach((line, r) => {
    let c = 0
    let land = false
    for (const token of line.split(".")) {
      const n = parseInt(token, 36)
      if (land) cells.fill(1, r * cols + c, r * cols + c + n)
      c += n
      land = !land
    }
  })
  return { step, cols, rows: lines.length, cells }
})()

export function isLand(lon: number, lat: number): boolean {
  const { step, cols, rows, cells } = mask
  const c = Math.floor(((((lon + 180) % 360) + 360) % 360) / step)
  const r = Math.floor((90 - lat) / step)
  if (r < 0 || r >= rows) return false
  return cells[r * cols + Math.min(cols - 1, c)] === 1
}

export type Point = { lat: number; lon: number }

/**
 * The point on Earth where the sun is overhead at `date`, from the low-precision
 * solar position of the Astronomical Almanac (good to about 0.01°).
 */
export function subsolar(date: Date): Point {
  const d = date.getTime() / 86400000 - 10957.5
  const g = (357.529 + 0.98560028 * d) * RAD
  const q = 280.459 + 0.98564736 * d
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD
  const e = (23.439 - 0.00000036 * d) * RAD
  const dec = Math.asin(Math.sin(e) * Math.sin(L))
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD
  const gmst = (280.46061837 + 360.98564736629 * d) % 360
  let lon = ra - gmst
  lon = ((((lon + 180) % 360) + 360) % 360) - 180
  return { lat: dec / RAD, lon }
}

/** The sun's elevation in degrees above the horizon at a place. */
export function elevation(lon: number, lat: number, sun: Point): number {
  const s =
    Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) +
    Math.cos(lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos((lon - sun.lon) * RAD)
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD
}

// Where a country's marker goes, [lon, lat]: a representative point on the
// populated part rather than the geometric centre where the two differ. The hub
// knows a node's country, not its city.
const PLACES: Record<string, [number, number]> = {
  AE: [54.3, 24.2], AR: [-64, -34], AT: [14.5, 47.6], AU: [134, -25.5], BE: [4.6, 50.6], BG: [25.3, 42.7],
  BR: [-51, -12], CA: [-100, 53], CH: [8.2, 46.8], CL: [-71.2, -33.5], CN: [108, 34.5], CO: [-74.1, 4.6],
  CZ: [15.4, 49.8], DE: [10.3, 51.1], DK: [9.4, 56], EE: [25, 58.7], ES: [-3.6, 40.2], FI: [25.8, 62.4],
  FR: [2.4, 46.7], GB: [-1.8, 52.8], GR: [22.6, 39.3], HK: [114.17, 22.32], HU: [19.4, 47.2], ID: [110.4, -7.3],
  IE: [-8, 53.2], IL: [34.9, 31.5], IN: [78.5, 22], IS: [-19, 64.9], IT: [12.6, 42.6], JP: [138.6, 36.2],
  KR: [127.8, 36.5], KZ: [67, 48.2], LT: [23.9, 55.3], LU: [6.1, 49.8], LV: [24.8, 56.9], MD: [28.5, 47.2],
  MO: [113.55, 22.17], MX: [-102, 23.6], MY: [102, 3.8], NL: [5.4, 52.2], NO: [9.5, 61], NZ: [174.5, -40.5],
  PH: [121, 14.6], PL: [19.3, 52.1], PT: [-8.2, 39.6], RO: [24.9, 45.9], RS: [20.9, 44.1], RU: [40, 56],
  SA: [45, 24], SE: [15.6, 60.1], SG: [103.82, 1.35], SK: [19.6, 48.7], TH: [100.9, 15], TR: [35, 39],
  TW: [121, 23.7], UA: [31.2, 49], US: [-97, 38.5], VN: [106, 16], ZA: [25, -29],
}
export const place = (code?: string | null): [number, number] | null => PLACES[String(code || "").toUpperCase()] || null

// Country names in the page's language, from the browser rather than a table.
const names: Record<string, Intl.DisplayNames> = {}
export function countryName(code?: string | null): string {
  if (!code) return ""
  const lang = intl()
  try {
    names[lang] ||= new Intl.DisplayNames([lang], { type: "region" })
    return names[lang].of(code.toUpperCase()) || code
  } catch {
    return code
  }
}

export type Sky = "day" | "night" | "dawn" | "dusk"

/** Daylight where a country's marker sits: day, night, or which twilight. */
export function sky(code?: string | null, date = new Date()): Sky | null {
  const p = place(code)
  if (!p) return null
  const el = elevation(p[0], p[1], subsolar(date))
  if (el > 0) return "day"
  if (el < -6) return "night"
  const solarHour = (((date.getUTCHours() + date.getUTCMinutes() / 60 + p[0] / 15) % 24) + 24) % 24
  return solarHour < 12 ? "dawn" : "dusk"
}
