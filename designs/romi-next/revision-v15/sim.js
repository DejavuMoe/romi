// A stand-in for the hub: pushes the node list every two seconds as /api/ws does,
// and answers history the way /api/nodes/{id}/metrics does. Values are synthetic
// and deterministic in time, so a window reads the same after a reload.
(function () {
  const F = window.romiFixtures
  const G = window.romiGeo
  const { MiB, GiB } = F.units
  const PUSH_MS = 2000
  const TAU = Math.PI * 2

  const hash = (a, b = 0) => {
    let h = (a * 374761393 + b * 668265263) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  // Smooth value noise in [-1, 1], period `p` seconds.
  const smooth = (t, p, seed) => {
    const x = t / p, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f)
    return (hash(i, seed) * (1 - u) + hash(i + 1, seed) * u) * 2 - 1
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

  // Solar hour where the node is: traffic follows the people it serves.
  const localHour = (node, t) => {
    const p = G.place(node.country)
    return ((((t / 3600) % 24) + (p ? p[0] / 15 : 8)) % 24 + 24) % 24
  }
  const diurnal = (h) => 0.58 + 0.42 * Math.cos(((h - 21) / 24) * TAU)

  // The value a node's metric would read at time t (seconds).
  // `span` is how many seconds the value summarises: a history bucket averages
  // away the second-to-second jitter a live push still shows.
  function sample(node, t, span = 2) {
    const b = node._sim.base
    const id = node.id
    const d = diurnal(localHour(node, t))
    const damp = Math.max(0.12, Math.min(1, Math.sqrt(30 / span)))
    const n1 = smooth(t, 12, id * 11) * damp, n2 = smooth(t, 190, id * 13) * Math.max(0.35, damp), n3 = smooth(t, 3600 * 5, id * 17)
    const burst = hash(Math.floor(t / 300), id * 7) > 0.93 ? 0.35 * Math.max(0, smooth(t, 60, id)) + 0.2 : 0
    const spike = burst * Math.max(0.3, damp)
    const cpu = clamp(b.cpu * (0.72 + 0.28 * d) * (1 + 0.22 * n1 + 0.2 * n2 + 0.12 * n3) + spike * 30, 0.4, 99.6)
    const load = (b.cpu_cores || 1) * cpu / 100
    const mem = clamp(b.memPct * (1 + 0.02 * n2 + 0.03 * n3), 1, 99.2)
    const disk = clamp(b.diskPct + 0.4 * smooth(t, 86400 * 3, id * 23), 0.5, 99.5)
    const traffic = d * (1 + 0.22 * n1 + 0.2 * n2) + spike
    return {
      cpu,
      load: [load * (1 + 0.1 * n1), load * (0.94 + 0.05 * n2), load * (0.9 + 0.03 * n3)],
      mem_used: (b.mem * GiB * mem) / 100,
      disk_used: (b.disk * GiB * disk) / 100,
      net_rx: Math.max(0, b.rx * traffic * 1.25),
      net_tx: Math.max(0, b.tx * traffic * 1.25),
      procs: Math.round(b.procs * (1 + 0.03 * n2 + 0.02 * n1)),
      tcp: Math.round(b.tcp * (0.6 + 0.4 * d) * (1 + 0.08 * n1)),
      udp: Math.round(b.udp * (1 + 0.15 * n2)),
      zram_used: b.zram ? b.zram.used * GiB * (1 + 0.1 * n3) : 0,
      swap_disk_used: (b.swapfile || 0) * GiB * (1 + 0.06 * n3),
    }
  }

  // Periods with no report, as [from, to] seconds, per node.
  const now0 = Date.now() / 1000
  const gaps = {
    5: [[now0 - 12 * 60, Infinity], [now0 - 2.4 * 86400, now0 - 2.4 * 86400 + 40 * 60], [now0 - 6.1 * 86400, now0 - 6.1 * 86400 + 3 * 3600]],
    6: [[now0 - 2 * 60, Infinity], [now0 - 9 * 3600, now0 - 9 * 3600 + 7 * 60], [now0 - 3.3 * 86400, now0 - 3.3 * 86400 + 25 * 60]],
    4: [[now0 - 4.2 * 86400, now0 - 4.2 * 86400 + 18 * 60]],
  }
  const inGap = (id, t) => (gaps[id] || []).some(([a, b]) => t >= a && t < b)
  const booted = (node, t) => {
    const b = node._sim.base
    if (b.state === "never") return false
    const since = b.state === "online" || b.state === "reconnecting" ? now0 - b.since : now0 - 40 * 86400
    return t >= Math.min(since, now0 - 40 * 86400)
  }

  // ---- live store ----------------------------------------------------------
  const nodes = F.nodes.map((n) => JSON.parse(JSON.stringify(n)))
  const SPARK = 90
  const spark = {}
  const listeners = new Set()
  let connected = true
  let tickCount = 0
  let paused = false

  function fillSpark(node) {
    const t = Date.now() / 1000
    spark[node.id] = Array.from({ length: SPARK }, (_, i) => {
      const at = t - (SPARK - 1 - i) * (PUSH_MS / 1000)
      if (node._sim.state === "never" || inGap(node.id, at)) return { t: at, cpu: null, rx: null, tx: null }
      const s = sample(node, at)
      return { t: at, cpu: s.cpu, rx: s.net_rx, tx: s.net_tx, mem: s.mem_used, disk: s.disk_used }
    })
  }
  nodes.forEach(fillSpark)

  function apply(node, t) {
    const m = node.metrics
    if (!m) return
    const s = sample(node, t)
    const dt = PUSH_MS / 1000
    Object.assign(m, {
      cpu: s.cpu, load: s.load, mem_used: s.mem_used, disk_used: s.disk_used, net_rx: s.net_rx, net_tx: s.net_tx,
      procs: s.procs, tcp: s.tcp, udp: s.udp, zram_used: s.zram_used, swap_disk_used: s.swap_disk_used,
      swapfile_used: s.swap_disk_used, swap_used: s.swap_disk_used,
    })
    m.uptime += dt
    const rx = s.net_rx * dt, tx = s.net_tx * dt
    node.total_rx += rx; node.total_tx += tx; node.month_rx += rx; node.month_tx += tx
    m.total_rx = node.total_rx; m.total_tx = node.total_tx; m.month_rx = node.month_rx; m.month_tx = node.month_tx
    node.last_seen = Math.round(t)
  }

  // The reconnecting node recovers and drops again, so the page shows both moves.
  function flap(node, t) {
    const sim = node._sim
    if (sim.base.state !== "reconnecting") return
    sim.clock = (sim.clock || 0) + PUSH_MS / 1000
    const phase = sim.clock % 110
    const shouldBeOnline = phase >= 24 && phase < 86
    if (shouldBeOnline && !node.online) {
      node.online = true
      sim.state = "online"
      sim.event = "recovered"
    } else if (!shouldBeOnline && node.online) {
      node.online = false
      sim.state = "reconnecting"
      sim.event = "dropped"
      node.last_seen = Math.round(t)
    } else sim.event = null
  }

  function tick() {
    if (paused || !connected) return
    const t = Date.now() / 1000
    tickCount++
    for (const node of nodes) {
      flap(node, t)
      if (node.online) apply(node, t)
      const s = node.online && node.metrics ? node.metrics : null
      const buf = spark[node.id]
      buf.push({ t, cpu: s ? s.cpu : null, rx: s ? s.net_rx : null, tx: s ? s.net_tx : null, mem: s ? s.mem_used : null, disk: s ? s.disk_used : null })
      if (buf.length > SPARK) buf.shift()
    }
    emit()
  }
  function emit() {
    for (const fn of listeners) fn(tickCount)
  }
  setInterval(tick, PUSH_MS)
  // Sample names follow the review language.
  window.romiI18n.subscribe(() => {
    for (const node of nodes) Object.assign(node, { name: F.localize(node.name), remark: F.localize(node.remark) })
    emit()
  })

  // ---- history ---------------------------------------------------------------
  function history(node, hours, points = 240) {
    if (!node || node._sim.base.state === "never") return []
    const end = Math.floor(Date.now() / 1000 / 60) * 60
    const step = Math.max(60, Math.round((hours * 3600) / points / 60) * 60)
    const out = []
    for (let t = end - (points - 1) * step; t <= end; t += step) {
      if (!booted(node, t) || inGap(node.id, t)) continue
      // A bucket summarises its span; average a few instants inside it.
      const a = sample(node, t, step), b2 = sample(node, t - step / 2, step)
      const mid = (k) => (a[k] + b2[k]) / 2
      out.push({
        ts: t, step, cpu: mid("cpu"), mem_used: mid("mem_used"), disk_used: mid("disk_used"),
        net_rx: mid("net_rx"), net_tx: mid("net_tx"), procs: Math.round(mid("procs")), tcp: Math.round(mid("tcp")),
        udp: Math.round(mid("udp")), zram_used: node._sim.base.zram ? mid("zram_used") : null,
        swap_disk_used: node._sim.base.swap ? mid("swap_disk_used") : null,
      })
    }
    return out
  }
  // Probe history for one node: one series per probe assigned to it.
  function pings(node, hours, probes, points = 240) {
    if (!node || node._sim.base.state === "never") return []
    const end = Math.floor(Date.now() / 1000 / 60) * 60
    const step = Math.max(60, Math.round((hours * 3600) / points / 60) * 60)
    return probes
      .filter((p) => p.nodes.includes(node.id))
      .map((p) => {
        const base = (F.latency[p.id] && F.latency[p.id][node.id]) || 60
        const rows = []
        let lostTotal = 0
        for (let t = end - (points - 1) * step; t <= end; t += step) {
          if (!booted(node, t) || inGap(node.id, t)) continue
          const d = diurnal(localHour(node, t))
          const jitter = smooth(t, 900, p.id * 31 + node.id) * 0.12 + smooth(t, 120, p.id * 7 + node.id * 3) * 0.05
          const congested = hash(Math.floor(t / 1800), p.id * 97 + node.id) > 0.9
          const med = base * (1 + 0.1 * (d - 0.5) + jitter + (congested ? 0.35 : 0))
          const r = hash(Math.floor(t / step), p.id * 53 + node.id * 5)
          const loss = congested && r > 0.55 ? Math.round((r - 0.5) * 30) : r > 0.985 ? 2 : 0
          lostTotal += loss
          const allLost = loss >= 12 && r > 0.97
          rows.push({
            ts: t, latency: allLost ? null : Math.max(1, med),
            band: allLost ? undefined : [Math.max(0.5, med * (0.86 - 0.05 * r)), med * (1.14 + (congested ? 0.4 : 0.08) * r)],
            loss: loss || undefined,
          })
        }
        return { id: p.id, name: p.name, rows, loss: rows.length ? lostTotal / rows.length : 0 }
      })
  }

  window.romiSim = {
    PUSH_MS,
    nodes: () => nodes,
    spark: (id) => spark[id] || [],
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    history,
    pings,
    tick: () => tickCount,
    connected: () => connected,
    setConnected(value) {
      connected = value
      emit()
    },
    pause(value) {
      paused = value
    },
    // Admin actions that change the list, standing in for the matching endpoints.
    addNode(name) {
      const id = Math.max(0, ...nodes.map((n) => n.id)) + 1
      const blank = F.nodes.find((n) => n.id === 10)
      const node = JSON.parse(JSON.stringify(blank))
      Object.assign(node, { id, sort: id, name, priority: 0, remark: "", country: "" })
      node._sim = { state: "never", base: { ...blank._sim.base, id, name } }
      nodes.push(node)
      fillSpark(node)
      emit()
      return node
    },
    // The first report from a freshly installed Agent.
    connect(id, like = 1) {
      const node = nodes.find((n) => n.id === id)
      const model = F.nodes.find((n) => n.id === like)
      if (!node || !model) return
      const base = { ...model._sim.base, id, name: node.name, since: 0, boot: 3 * 60 + 12, state: "online" }
      const fresh = JSON.parse(JSON.stringify(model))
      const ip = `198.51.100.${20 + (id % 200)}`
      Object.assign(node, {
        online: true, country: model.country, os: fresh.os, kernel: fresh.kernel, arch: fresh.arch, virt: fresh.virt,
        cpu_name: fresh.cpu_name, cpu_cores: fresh.cpu_cores, mem_total: fresh.mem_total, swap_total: fresh.swap_total,
        disk_total: fresh.disk_total, agent_version: "0.1.0", metrics: fresh.metrics, last_seen: Math.round(Date.now() / 1000),
        online_since: Math.round(Date.now() / 1000), total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
        ipv4: ip, ip, ipv6: "", has_ipv4: true, has_ipv6: false, hostname: node.name.split("·").pop().trim().replace(/\s+/g, "-"),
      })
      node.metrics.uptime = base.boot
      node.metrics.total_rx = node.metrics.total_tx = node.metrics.month_rx = node.metrics.month_tx = 0
      base.rx = model._sim.base.rx * 0.2
      base.tx = model._sim.base.tx * 0.2
      base.cpu = 4
      node._sim = { state: "online", base, event: "joined" }
      fillSpark(node)
      spark[id] = spark[id].map((p) => ({ ...p, cpu: null, rx: null, tx: null }))
      emit()
    },
    update(id, patch) {
      const node = nodes.find((n) => n.id === id)
      if (node) Object.assign(node, patch)
      nodes.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id)
      emit()
    },
    remove(id) {
      const i = nodes.findIndex((n) => n.id === id)
      if (i >= 0) nodes.splice(i, 1)
      emit()
    },
  }
  nodes.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id)
})()
