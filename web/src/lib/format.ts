import { bytes, CYCLES, money, monthUsage, UNITS, unitOf } from "../../../shared/format.ts"
import { getLocale, intl, T } from "../../../shared/i18n.ts"
import type { Node } from "../../../shared/nodes.ts"
export { continuousUptime, bytes, uptime, FOREVER, money, CYCLES, monthUsage } from "../../../shared/format.ts"
export { usageTone as tone } from "../../../shared/usage.ts"

/**
 * A "used / total" pair. Sharing a unit means writing it once, and those four
 * characters are what allow the two decimals: 111px against the 122px a card in
 * the four-column grid provides, where separate units require 132px. A pair
 * spanning two units has nothing to save and falls back to bytes().
 */
export function pair(used: number, total: number): string {
  if (used > 0 && total > 0 && unitOf(used) === unitOf(total)) {
    const i = unitOf(total)
    const f = (n: number) => (n / 1024 ** i).toFixed(i === 0 ? 0 : 2)
    return `${f(used)} / ${f(total)} ${UNITS[i]}`
  }
  return `${bytes(used)} / ${bytes(total)}`
}

/** The number and its unit apart, for layouts that set the unit smaller. */
export function bytesParts(n: number, digits?: number) {
  const [value, unit] = bytes(n, digits).split(" ")
  return { value, unit }
}

/**
 * Axis ticks. Whole units are too coarse for a narrow band -- a disk at 3.2 GB
 * would draw 3 GB, 2 GB, 2 GB, 811 MB, 0 B, repeating a label -- so ticks under
 * three digits keep one decimal. Above that the next tick is a whole unit away
 * and the label must stay within the axis.
 */
export function axisBytes(v: number): string {
  if (!v || v < 0) return "0 B"
  const unit = unitOf(v)
  return bytes(v, v / 1024 ** unit >= 100 ? 0 : 1).replace(".0 ", " ")
}

export function rate(n: number): string {
  return `${bytes(n, 1)}/s`
}

export function rateParts(n: number) {
  const { value, unit } = bytesParts(n, 1)
  return { value, unit: `${unit}/s` }
}

export function percent(used: number, total: number): number {
  return total > 0 ? Math.min(100, (used / total) * 100) : 0
}

/** Whole days until a date, negative once it has passed. */
export function daysUntil(date?: string | null): number | null {
  if (!date) return null
  const target = new Date(`${date}T00:00:00`).getTime()
  if (Number.isNaN(target)) return null
  return Math.ceil((target - Date.now()) / 86400000)
}

/** When the plan runs out, in words, and how urgently to show it. */
export function expiry(node: Pick<Node, "expires_at">): { text: string; tone: "muted" | "warn" | "bad"; days: number | null } {
  const days = daysUntil(node.expires_at)
  if (days === null) return { text: T("永不到期"), tone: "muted", days }
  if (days < 0) return { text: T("已过期 {n} 天", { n: -days }), tone: "bad", days }
  if (days === 0) return { text: T("今日到期"), tone: "warn", days }
  return { text: T("{n} 天后到期", { n: days }), tone: days <= 7 ? "warn" : "muted", days }
}

/** Remove the distribution codename while keeping its version. */
export function osName(name: string): string {
  return (name || "").replace("GNU/Linux ", "").replace(/\s*\([^)]*\)\s*$/, "")
}

/** Configured link capacity, in decimal megabits as the operator entered it. */
export function bandwidth(value?: number): string {
  return !value ? T("未设置") : value >= 1000 ? `${value / 1000} Gbps` : `${value} Mbps`
}

export const cycle = (key: string) => (CYCLES[key] ? T(CYCLES[key]) : key)

export function price(node: Pick<Node, "price" | "currency" | "billing_cycle">): string {
  return node.price > 0 ? `${money(node.price, node.currency)} / ${cycle(node.billing_cycle)}` : T("免费")
}

export const MODES: Record<string, string> = { sum: "上下行相加", max: "取较大值", up: "仅上行", down: "仅下行" }

/** The next reset of the billing period, from its day of the month. */
export function nextReset(day: number, now = new Date()): Date {
  const y = now.getFullYear(), m = now.getMonth()
  const clamp = (yy: number, mm: number) => Math.min(day, new Date(yy, mm + 1, 0).getDate())
  let at = new Date(y, m, clamp(y, m))
  if (at <= now) at = new Date(y, m + 1, clamp(y, m + 1))
  return at
}

export function periodStart(day: number, now = new Date()): Date {
  const next = nextReset(day, now)
  const y = next.getFullYear(), m = next.getMonth() - 1
  return new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()))
}

/**
 * Usage at the end of the period if the pace so far continues; null in the
 * first days, when there is too little of the period to extrapolate from.
 */
export function projection(node: Pick<Node, "traffic_reset_day" | "month_rx" | "month_tx" | "traffic_mode">, now = new Date()) {
  const start = periodStart(node.traffic_reset_day || 1, now)
  const end = nextReset(node.traffic_reset_day || 1, now)
  const elapsed = (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())
  const used = monthUsage(node)
  if (elapsed < 0.08 || !used) return null
  return { value: used / elapsed, end }
}

// One formatter per language and shape, made on first use; chart layout formats
// many epoch-millisecond values.
const SHAPES: Record<string, Intl.DateTimeFormatOptions> = {
  clock: { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  hhmm: { hour: "2-digit", minute: "2-digit", hour12: false },
  mdhhmm: { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
  full: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
  day: { month: "short", day: "numeric" },
}
const formatters: Record<string, Intl.DateTimeFormat> = {}
const dt = (shape: string) => (formatters[`${intl()}/${shape}`] ||= new Intl.DateTimeFormat(intl(), SHAPES[shape]))

export const clock = (ms: number) => dt("clock").format(ms)
export const full = (ms: number) => dt("full").format(ms)
export const shortDate = (d: Date) => (getLocale() === "zh-CN" ? T("{m} 月 {d} 日", { m: d.getMonth() + 1, d: d.getDate() }) : dt("day").format(d))

/**
 * Axis ticks for a window `hours` wide. Beyond a day a bare "14:00" recurs each
 * midnight and the axis no longer indicates which day it refers to.
 */
export function clockFor(hours: number): (ms: number) => string {
  const shape = hours <= 24 ? "hhmm" : "mdhhmm"
  return (ms) => dt(shape).format(ms)
}

export function ago(seconds: number): string {
  if (seconds < 60) return T("刚刚")
  if (seconds < 3600) return T("{n} 分钟前", { n: Math.floor(seconds / 60) })
  if (seconds < 86400) return T("{n} 小时前", { n: Math.floor(seconds / 3600) })
  return T("{n} 天前", { n: Math.floor(seconds / 86400) })
}

// Ticks on round clock values across `[from, to]`, in epoch milliseconds.
//
// recharts selects ticks by "nice number" on the raw value, which on a timestamp
// yields 05:14 and 10:22 where a chart requires 06:00 and 12:00; it never uses a
// time scale's own ticks, whatever `scale` specifies. The axis is therefore given
// the list explicitly: the smallest step from the ladder keeping the count under
// `count`, phased on local midnight so a daily tick lands on the day even in a
// zone offset by 30 or 45 minutes.
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 43200, 86400].map((m) => m * 60_000)

export function timeTicks(from: number, to: number, count = 8): number[] {
  const step = TICK_STEPS.find((s) => (to - from) / s <= count) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const zone = new Date(from).getTimezoneOffset() * 60_000
  const ticks: number[] = []
  for (let t = Math.ceil((from - zone) / step) * step + zone; t <= to; t += step) ticks.push(t)
  return ticks
}

/** A clean top for a value axis that starts at zero. */
export function niceMax(v: number, kind?: "bytes"): number {
  if (!(v > 0)) return 1
  if (kind === "bytes") {
    const i = unitOf(v), u = 1024 ** i, s = v / u
    const m = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 128, 160, 200, 256, 400, 500, 512, 800, 1000, 1024].find((x) => x >= s) || 1024
    return m * u
  }
  const p = 10 ** Math.floor(Math.log10(v)), s = v / p
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x >= s) || 10) * p
}

export function withHistoryGaps<P extends { ts: number; step?: number }>(points: P[]): (P | { ts: number })[] {
  return points.flatMap((point, index) => {
    const previous = points[index - 1], step = point.step ?? 60
    return previous && point.ts - previous.ts > step ? [{ ts: previous.ts + step }, point] : [point]
  })
}

/** The viewer's offset from UTC, which every time on the page is shown in. */
export function zoneLabel(date = new Date()): string {
  const off = -date.getTimezoneOffset()
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")
  const mm = String(Math.abs(off) % 60).padStart(2, "0")
  return `UTC${off < 0 ? "−" : "+"}${hh}:${mm}`
}
