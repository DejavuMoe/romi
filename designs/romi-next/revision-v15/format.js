// Formatting, mirrored from shared/format.ts, shared/nodes.ts, shared/usage.ts and
// web/src/lib/format.ts so every figure reads as production writes it. Words go
// through T() and dates through Intl, in the page's language at call time.
(function () {
  const I = window.romiI18n
  const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  const unitOf = (n) => Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)

  function bytes(n, digits) {
    if (!n || n < 1) return "0 B"
    const i = unitOf(n)
    const v = n / 1024 ** i
    return `${v.toFixed(i === 0 ? 0 : (digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2)))} ${UNITS[i]}`
  }
  // The number and its unit apart, for layouts that set the unit smaller.
  function bytesParts(n, digits) {
    const [value, unit] = bytes(n, digits).split(" ")
    return { value, unit }
  }
  function pair(used, total) {
    if (used > 0 && total > 0 && unitOf(used) === unitOf(total)) {
      const i = unitOf(total)
      const f = (n) => (n / 1024 ** i).toFixed(i === 0 ? 0 : 2)
      return `${f(used)} / ${f(total)} ${UNITS[i]}`
    }
    return `${bytes(used)} / ${bytes(total)}`
  }
  const rate = (n) => `${bytes(n, 1)}/s`
  function rateParts(n) {
    const { value, unit } = bytesParts(n, 1)
    return { value, unit: `${unit}/s` }
  }
  const percent = (used, total) => (total > 0 ? Math.min(100, (used / total) * 100) : 0)
  function axisBytes(v) {
    if (!v || v < 0) return "0 B"
    const unit = unitOf(v)
    return bytes(v, v / 1024 ** unit >= 100 ? 0 : 1).replace(".0 ", " ")
  }

  function uptime(seconds) {
    if (!seconds) return "—"
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return d > 0 ? T("{d} 天 {h} 小时", { d, h }) : h > 0 ? T("{h} 小时 {m} 分", { h, m }) : T("{m} 分", { m })
  }
  const SYMBOLS = { USD: "$", CNY: "¥", EUR: "€", GBP: "£", JPY: "¥" }
  const money = (amount, currency) =>
    `${SYMBOLS[currency] ?? ""}${Number(amount).toFixed(2)}${SYMBOLS[currency] ? "" : ` ${currency}`}`
  const CYCLES = { monthly: "月付", quarterly: "季付", semiannual: "半年付", yearly: "年付", biennial: "两年付", triennial: "三年付", once: "一次性" }
  const MODES = { sum: "上下行相加", max: "取较大值", up: "仅上行", down: "仅下行" }
  const translated = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, T(v)]))

  function monthUsage(node) {
    switch (node.traffic_mode) {
      case "up": return node.month_tx
      case "down": return node.month_rx
      case "max": return Math.max(node.month_rx, node.month_tx)
      default: return node.month_rx + node.month_tx
    }
  }
  const nowSec = () => Date.now() / 1000
  function connection(node, now = nowSec()) {
    if (node.online) return "online"
    if (!node.last_seen) return "never"
    return now - node.last_seen <= (node.online_grace_minutes ?? 5) * 60 ? "reconnecting" : "offline"
  }
  const CONNECTION = { online: "在线", reconnecting: "重连中", offline: "离线", never: "未连接" }
  const connectionLabel = (node, now) => T(CONNECTION[connection(node, now)])
  function continuousUptime(node, now = nowSec()) {
    if (!node.last_seen) return T("尚未接入")
    if (node.online) return node.online_since ? uptime(Math.max(0, now - node.online_since)) : T("待上报")
    return now - node.last_seen <= (node.online_grace_minutes ?? 5) * 60 ? T("等待恢复") : T("已中断")
  }
  function daysUntil(date) {
    if (!date) return null
    const target = new Date(`${date}T00:00:00`).getTime()
    if (Number.isNaN(target)) return null
    return Math.ceil((target - Date.now()) / 86400000)
  }
  function expiry(node) {
    const days = daysUntil(node.expires_at)
    if (days === null) return { text: T("永不到期"), tone: "muted", days }
    if (days < 0) return { text: T("已过期 {n} 天", { n: -days }), tone: "bad", days }
    if (days === 0) return { text: T("今日到期"), tone: "warn", days }
    return { text: T("{n} 天后到期", { n: days }), tone: days <= 7 ? "warn" : "muted", days }
  }
  const osName = (name) => (name || "").replace("GNU/Linux ", "").replace(/\s*\([^)]*\)\s*$/, "")
  const bandwidth = (value) => (!value ? T("未设置") : value >= 1000 ? `${value / 1000} Gbps` : `${value} Mbps`)
  const tone = (value) =>
    value == null || !Number.isFinite(value) ? "unknown" : value >= 85 ? "critical" : value >= 60 ? "warning" : "normal"
  const price = (node) => (node.price > 0 ? `${money(node.price, node.currency)} / ${CYCLES[node.billing_cycle] ? T(CYCLES[node.billing_cycle]) : node.billing_cycle}` : T("免费"))

  // Next reset of the billing period, from the configured day of month.
  function nextReset(day, now = new Date()) {
    const y = now.getFullYear(), m = now.getMonth()
    const clamp = (yy, mm) => Math.min(day, new Date(yy, mm + 1, 0).getDate())
    let at = new Date(y, m, clamp(y, m))
    if (at <= now) at = new Date(y, m + 1, clamp(y, m + 1))
    return at
  }
  function periodStart(day, now = new Date()) {
    const next = nextReset(day, now)
    const y = next.getFullYear(), m = next.getMonth() - 1
    return new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()))
  }
  // Usage at the end of the period if the rate so far continues.
  function projection(node, now = new Date()) {
    const start = periodStart(node.traffic_reset_day || 1, now)
    const end = nextReset(node.traffic_reset_day || 1, now)
    const elapsed = (now - start) / (end - start)
    const used = monthUsage(node)
    if (elapsed < 0.08 || !used) return null
    return { value: used / elapsed, end }
  }
  // One formatter per language and shape, made on first use.
  const formatters = {}
  const SHAPES = {
    clock: { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
    hhmm: { hour: "2-digit", minute: "2-digit", hour12: false },
    mdhhmm: { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
    full: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
    day: { month: "short", day: "numeric" },
  }
  const dt = (shape) => (formatters[`${I.intl}/${shape}`] ||= new Intl.DateTimeFormat(I.intl, SHAPES[shape]))
  const shortDate = (d) => (I.locale === "zh-CN" ? T("{m} 月 {d} 日", { m: d.getMonth() + 1, d: d.getDate() }) : dt("day").format(d))
  const clock = (ms) => dt("clock").format(ms)
  const clockFor = (hours) => dt(hours <= 24 ? "hhmm" : "mdhhmm").format
  const full = (ms) => dt("full").format(ms)
  function ago(seconds) {
    if (seconds < 60) return T("刚刚")
    if (seconds < 3600) return T("{n} 分钟前", { n: Math.floor(seconds / 60) })
    if (seconds < 86400) return T("{n} 小时前", { n: Math.floor(seconds / 3600) })
    return T("{n} 天前", { n: Math.floor(seconds / 86400) })
  }

  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 43200, 86400].map((m) => m * 60000)
  function timeTicks(from, to, count = 6) {
    const step = TICK_STEPS.find((s) => (to - from) / s <= count) ?? TICK_STEPS[TICK_STEPS.length - 1]
    const zone = new Date(from).getTimezoneOffset() * 60000
    const ticks = []
    for (let t = Math.ceil((from - zone) / step) * step + zone; t <= to; t += step) ticks.push(t)
    return ticks
  }
  // Clean value-axis ticks from zero.
  function niceMax(v, kind) {
    if (!(v > 0)) return 1
    if (kind === "bytes") {
      const i = unitOf(v), u = 1024 ** i, s = v / u
      const m = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 128, 160, 200, 256, 400, 500, 512, 800, 1000, 1024].find((x) => x >= s) || 1024
      return m * u
    }
    const p = 10 ** Math.floor(Math.log10(v)), s = v / p
    return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x >= s) || 10) * p
  }

  // shared/validate.ts: the message for what was typed, "" when acceptable.
  function numericError(raw, { min = 0, max = Infinity, step = 1, required = false } = {}) {
    raw = String(raw ?? "")
    if (raw === "") return required ? T("请填写此项") : ""
    const integer = step === 1
    if (!(integer ? /^\d+$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/).test(raw)) return integer ? T("请输入非负整数") : T("请输入非负数")
    const n = Number(raw)
    if (!Number.isFinite(n)) return T("数值过大")
    if (n < min) return T("不能小于 {min}", { min })
    if (n > max) return T("不能大于 {max}", { max })
    if (step !== "any" && Math.abs((n - min) / step - Math.round((n - min) / step)) > 1e-7) return T("请按 {step} 的步长填写", { step })
    return ""
  }
  function dateError(raw) {
    if (!raw) return ""
    const d = new Date(raw + "T00:00:00Z")
    return !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? T("请输入有效日期") : ""
  }

  window.romiFormat = {
    numericError, dateError,
    UNITS, unitOf, bytes, bytesParts, pair, rate, rateParts, percent, axisBytes, uptime, money,
    monthUsage, connection, connectionLabel, continuousUptime, daysUntil, expiry, osName, bandwidth, tone,
    price, nextReset, periodStart, projection, shortDate, clock, clockFor, full, ago, timeTicks, niceMax,
    // Labels in the page's language, read when used.
    get FOREVER() { return T("永不到期") },
    get CYCLES() { return translated(CYCLES) },
    get MODES() { return translated(MODES) },
    get CONNECTION() { return translated(CONNECTION) },
  }
})()
