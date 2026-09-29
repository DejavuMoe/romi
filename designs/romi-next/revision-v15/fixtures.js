// Synthetic, sanitised sample data in the shapes the hub serves (shared/nodes.ts,
// /api/ping-tasks, /api/settings, /api/sessions, /api/db, /api/geolite). Addresses
// are documentation ranges, names are invented, targets use `.invalid`.
(function () {
  const KiB = 1024, MiB = KiB * 1024, GiB = MiB * 1024, TiB = GiB * 1024
  const now = Date.now() / 1000
  const DAY = 86400, HOUR = 3600, MIN = 60
  const date = (days) => {
    const d = new Date((now + days * DAY) * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }
  const monthStart = (() => {
    const d = new Date(now * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`
  })()

  // Base values the simulation walks around. `cpu`, `mem`, `disk` are percent;
  // rates are bytes per second.
  const base = [
    {
      id: 1, name: "东京 · edge-01", country: "JP", priority: 90, public: true, state: "online",
      os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.12.43-amd64", arch: "x86_64", virt: "kvm",
      cpu_name: "Intel Xeon E5-2680 v4", cpu_cores: 2, mem: 4, disk: 80, swap: 1,
      cpu: 24, memPct: 42, diskPct: 31, rx: 12.4 * MiB, tx: 3.8 * MiB, procs: 127, tcp: 205, udp: 22,
      price: 5, currency: "USD", billing_cycle: "monthly", expires: 29,
      traffic_limit: 1000 * GiB, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 1.64 * TiB, total_tx: 840 * GiB, month_rx: 200 * GiB, month_tx: 126 * GiB,
      bandwidth_down: 1000, bandwidth_up: 1000, ipv4: "192.0.2.11", ipv6: "2001:db8::11",
      since: 32 * DAY + 6 * HOUR, boot: 2 * HOUR + 16 * MIN, remark: "前端入口", notify: true,
      swapfile: 0.2, zram: null,
    },
    {
      id: 2, name: "新加坡 · core-02", country: "SG", priority: 80, public: true, state: "online",
      os: "Alpine Linux v3.22", kernel: "6.12.43-0-lts", arch: "aarch64", virt: "kvm",
      cpu_name: "Ampere Altra", cpu_cores: 4, mem: 8, disk: 160, swap: 0,
      cpu: 61, memPct: 68, diskPct: 46, rx: 8.2 * MiB, tx: 5.1 * MiB, procs: 188, tcp: 642, udp: 41,
      price: 8, currency: "USD", billing_cycle: "monthly", expires: 29,
      traffic_limit: 1000 * GiB, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 2.19 * TiB, total_tx: 1.09 * TiB, month_rx: 431 * GiB, month_tx: 287 * GiB,
      bandwidth_down: 1000, bandwidth_up: 1000, ipv4: "192.0.2.12", ipv6: "2001:db8::12",
      since: 18 * DAY + 2 * HOUR, boot: 18 * DAY + 2 * HOUR, remark: "API 与队列", notify: true,
      swapfile: 0, zram: { total: 2, used: 0.32, devices: 1 },
    },
    {
      id: 3, name: "香港 · relay-03", country: "HK", priority: 70, public: false, state: "online",
      os: "Debian GNU/Linux 13 (trixie)", kernel: "6.12.48+deb13-amd64", arch: "x86_64", virt: "kvm",
      cpu_name: "AMD EPYC 7B12", cpu_cores: 2, mem: 2, disk: 40, swap: 0,
      cpu: 13, memPct: 29, diskPct: 22, rx: 4.6 * MiB, tx: 2.3 * MiB, procs: 96, tcp: 131, udp: 12,
      price: 30, currency: "CNY", billing_cycle: "monthly", expires: 17,
      traffic_limit: 500 * GiB, traffic_mode: "max", traffic_reset_day: 15, traffic_unit: "GB",
      total_rx: 960 * GiB, total_tx: 480 * GiB, month_rx: 142 * GiB, month_tx: 71 * GiB,
      bandwidth_down: 2500, bandwidth_up: 500, ipv4: "192.0.2.13", ipv6: "2001:db8::13",
      since: 46 * DAY + 11 * HOUR, boot: 46 * DAY + 11 * HOUR, remark: "中转，仅内部", notify: true,
      swapfile: 0, zram: { total: 1, used: 0.18, devices: 1 },
    },
    {
      id: 4, name: "法兰克福 · eu-01", country: "DE", priority: 60, public: true, state: "online",
      os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.12.43-arm64", arch: "aarch64", virt: "kvm",
      cpu_name: "Ampere Altra", cpu_cores: 2, mem: 4, disk: 80, swap: 0,
      cpu: 91, memPct: 87, diskPct: 92, rx: 1.8 * MiB, tx: 0.7 * MiB, procs: 214, tcp: 488, udp: 30,
      price: 36, currency: "EUR", billing_cycle: "yearly", expires: 365,
      traffic_limit: 500 * GiB, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 320 * GiB, total_tx: 160 * GiB, month_rx: 58 * GiB, month_tx: 31 * GiB,
      bandwidth_down: 1000, bandwidth_up: 1000, ipv4: "192.0.2.14", ipv6: "2001:db8::14",
      since: 9 * DAY + 15 * HOUR, boot: 9 * DAY + 15 * HOUR, remark: "构建与备份", notify: true,
      swapfile: 0, zram: null,
    },
    {
      id: 5, name: "洛杉矶 · west-01", country: "US", priority: 50, public: true, state: "offline", gap: 12 * MIN,
      os: "Alpine Linux v3.22", kernel: "6.12.43-0-lts", arch: "x86_64", virt: "kvm",
      cpu_name: "Intel Xeon E5-2680 v4", cpu_cores: 2, mem: 4, disk: 80, swap: 0.5,
      cpu: 0, memPct: 0, diskPct: 40, rx: 0, tx: 0, procs: 0, tcp: 0, udp: 0,
      price: 4, currency: "USD", billing_cycle: "monthly", expires: -2,
      traffic_limit: 1000 * GiB, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 184 * GiB, total_tx: 92 * GiB, month_rx: 132 * GiB, month_tx: 72 * GiB,
      bandwidth_down: 1000, bandwidth_up: 1000, ipv4: "192.0.2.15", ipv6: null,
      since: 0, boot: 0, remark: "", notify: true, swapfile: 0, zram: null,
    },
    {
      id: 6, name: "阿姆斯特丹 · ams-01", country: "NL", priority: 45, public: true, state: "reconnecting", gap: 2 * MIN,
      os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-79-generic", arch: "x86_64", virt: "kvm",
      cpu_name: "Intel Xeon Gold 6148", cpu_cores: 2, mem: 2, disk: 50, swap: 1,
      cpu: 19, memPct: 38, diskPct: 27, rx: 2.9 * MiB, tx: 1.2 * MiB, procs: 104, tcp: 96, udp: 9,
      price: 3.5, currency: "EUR", billing_cycle: "monthly", expires: 12,
      traffic_limit: 2 * TiB, traffic_mode: "down", traffic_reset_day: 8, traffic_unit: "TB",
      total_rx: 3.1 * TiB, total_tx: 610 * GiB, month_rx: 690 * GiB, month_tx: 98 * GiB,
      bandwidth_down: 10000, bandwidth_up: 10000, ipv4: "192.0.2.16", ipv6: "2001:db8::16",
      since: 5 * DAY + 3 * HOUR, boot: 5 * DAY + 3 * HOUR, remark: "镜像源", notify: false,
      swapfile: 0.4, zram: null,
    },
    {
      id: 7, name: "首尔 · kr-01", country: "KR", priority: 40, public: true, state: "online",
      os: "Rocky Linux 9.6 (Blue Onyx)", kernel: "5.14.0-570.el9.x86_64", arch: "x86_64", virt: "kvm",
      cpu_name: "AMD EPYC 7763", cpu_cores: 2, mem: 2, disk: 40, swap: 0,
      cpu: 7, memPct: 33, diskPct: 18, rx: 6.1 * MiB, tx: 5.4 * MiB, procs: 91, tcp: 77, udp: 8,
      price: 6, currency: "USD", billing_cycle: "monthly", expires: 5,
      traffic_limit: 500 * GiB, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 1.1 * TiB, total_tx: 980 * GiB, month_rx: 219 * GiB, month_tx: 193 * GiB,
      bandwidth_down: 300, bandwidth_up: 300, ipv4: "192.0.2.17", ipv6: null,
      since: 21 * DAY + 4 * HOUR, boot: 21 * DAY + 4 * HOUR, remark: "", notify: true,
      swapfile: 0, zram: null,
    },
    {
      id: 8, name: "圣何塞 · sjc-02", country: "US", priority: 30, public: true, state: "online",
      os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.1.0-39-amd64", arch: "x86_64", virt: "lxc",
      cpu_name: "Intel Xeon Platinum 8272CL", cpu_cores: 1, mem: 1, disk: 20, swap: 0.5,
      cpu: 34, memPct: 51, diskPct: 63, rx: 1.3 * MiB, tx: 2.2 * MiB, procs: 58, tcp: 43, udp: 6,
      price: 0, currency: "USD", billing_cycle: "monthly", expires: null,
      traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 402 * GiB, total_tx: 655 * GiB, month_rx: 61 * GiB, month_tx: 97 * GiB,
      bandwidth_down: 0, bandwidth_up: 0, ipv4: "192.0.2.18", ipv6: "2001:db8::18",
      since: 63 * DAY + 20 * HOUR, boot: 63 * DAY + 20 * HOUR, remark: "免费实例", notify: false,
      swapfile: 0.1, zram: null,
    },
    {
      id: 9, name: "悉尼 · syd-01", country: "AU", priority: 20, public: true, state: "online",
      os: "Ubuntu 22.04.5 LTS", kernel: "6.8.0-1031-oracle", arch: "aarch64", virt: "kvm",
      cpu_name: "Ampere Altra", cpu_cores: 4, mem: 24, disk: 200, swap: 0,
      cpu: 18, memPct: 46, diskPct: 39, rx: 3.3 * MiB, tx: 1.9 * MiB, procs: 162, tcp: 158, udp: 14,
      price: 12, currency: "USD", billing_cycle: "quarterly", expires: 54,
      traffic_limit: 10 * TiB, traffic_mode: "up", traffic_reset_day: 1, traffic_unit: "TB",
      total_rx: 1.4 * TiB, total_tx: 760 * GiB, month_rx: 244 * GiB, month_tx: 121 * GiB,
      bandwidth_down: 4000, bandwidth_up: 4000, ipv4: "192.0.2.19", ipv6: "2001:db8::19",
      since: 12 * DAY + 9 * HOUR, boot: 40 * DAY + 2 * HOUR, remark: "", notify: true,
      swapfile: 0, zram: { total: 4, used: 0, devices: 1 },
    },
    {
      id: 10, name: "备用 · standby", country: "", priority: 0, public: true, state: "never",
      os: "", kernel: "", arch: "", virt: "", cpu_name: "", cpu_cores: 0, mem: 0, disk: 0, swap: 0,
      cpu: 0, memPct: 0, diskPct: 0, rx: 0, tx: 0, procs: 0, tcp: 0, udp: 0,
      price: 0, currency: "USD", billing_cycle: "monthly", expires: null,
      traffic_limit: 500 * GiB, traffic_mode: "sum", traffic_reset_day: 1, traffic_unit: "GB",
      total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
      bandwidth_down: 0, bandwidth_up: 0, ipv4: null, ipv6: null,
      since: 0, boot: 0, remark: "", notify: true, swapfile: 0, zram: null,
    },
  ]

  function toNode(b) {
    const online = b.state === "online"
    const seen = b.state === "never" ? 0 : online ? now - 1 : now - (b.gap || 0)
    const metrics = b.state === "never" ? null : {
      uptime: b.boot,
      cpu: b.cpu,
      load: [b.cpu / 100 * b.cpu_cores * 1.1, b.cpu / 100 * b.cpu_cores * 0.95, b.cpu / 100 * b.cpu_cores * 0.8],
      mem_total: b.mem * GiB,
      mem_used: b.mem * GiB * b.memPct / 100,
      swap_total: b.swap * GiB,
      swap_used: (b.swapfile || 0) * GiB,
      zram_used: b.zram ? b.zram.used * GiB : 0,
      zram_total: b.zram ? b.zram.total * GiB : 0,
      zram_devices: b.zram ? b.zram.devices : 0,
      swap_disk_used: (b.swapfile || 0) * GiB,
      swap_disk_total: b.swap * GiB,
      swapfile_used: (b.swapfile || 0) * GiB,
      swap_partition_used: 0,
      disk_total: b.disk * GiB,
      disk_used: b.disk * GiB * b.diskPct / 100,
      net_rx: b.rx,
      net_tx: b.tx,
      total_rx: b.total_rx,
      total_tx: b.total_tx,
      month_rx: b.month_rx,
      month_tx: b.month_tx,
      tcp: b.tcp,
      udp: b.udp,
      procs: b.procs,
    }
    return {
      id: b.id, name: b.name, sort: b.id, priority: b.priority, public: b.public, online,
      country: b.country, last_seen: Math.round(seen), online_grace_minutes: 5,
      online_since: online || b.state === "reconnecting" ? Math.round(now - b.since) : 0,
      metrics, os: b.os, kernel: b.kernel, arch: b.arch, virt: b.virt, cpu_name: b.cpu_name,
      cpu_cores: b.cpu_cores, mem_total: b.mem * GiB, swap_total: b.swap * GiB, disk_total: b.disk * GiB,
      agent_version: b.state === "never" ? "" : "0.1.0",
      price: b.price, currency: b.currency, billing_cycle: b.billing_cycle,
      expires_at: b.expires === null ? null : date(b.expires),
      traffic_limit: b.traffic_limit, traffic_mode: b.traffic_mode, traffic_reset_day: b.traffic_reset_day,
      traffic_unit: b.traffic_unit,
      total_rx: b.total_rx, total_tx: b.total_tx, month_rx: b.month_rx, month_tx: b.month_tx,
      month_start: monthStart, day_rx: b.month_rx / 20, day_tx: b.month_tx / 20,
      bandwidth_down: b.bandwidth_down, bandwidth_up: b.bandwidth_up,
      has_ipv4: !!b.ipv4, has_ipv6: !!b.ipv6,
      hostname: b.state === "never" ? "" : b.name.split(" · ")[1],
      ip: b.ipv4 || "", ipv4: b.ipv4 || "", ipv6: b.ipv6 || "",
      notify: b.notify, remark: b.remark,
      // Prototype-only: which state the simulation plays for this node.
      _sim: { state: b.state, base: b },
    }
  }

  // Names, remarks and probe names in the review language. The hub stores
  // whatever an admin typed; this only keeps the sample readable in both.
  const EN = {
    "东京 · edge-01": "Tokyo · edge-01", "新加坡 · core-02": "Singapore · core-02", "香港 · relay-03": "Hong Kong · relay-03",
    "法兰克福 · eu-01": "Frankfurt · eu-01", "洛杉矶 · west-01": "Los Angeles · west-01", "阿姆斯特丹 · ams-01": "Amsterdam · ams-01",
    "首尔 · kr-01": "Seoul · kr-01", "圣何塞 · sjc-02": "San Jose · sjc-02", "悉尼 · syd-01": "Sydney · syd-01", "备用 · standby": "Standby · standby",
    "前端入口": "Front door", "API 与队列": "API and queue", "中转，仅内部": "Relay, internal only", "构建与备份": "Builds and backups",
    "镜像源": "Package mirror", "免费实例": "Free instance", "主站 HTTPS": "Main site HTTPS", "备用入口": "Backup entry", "对象存储": "Object storage",
  }
  const ZH = Object.fromEntries(Object.entries(EN).map(([zh, en]) => [en, zh]))
  const localize = (text) => (window.romiI18n && window.romiI18n.locale === "en" ? EN[text] : ZH[text]) ?? text
  base.forEach((b) => Object.assign(b, { name: localize(b.name), remark: localize(b.remark) }))

  const nodes = base.map(toNode)

  const probeList = [
    { id: 1, name: "主站 HTTPS", target: "www.example.invalid:443", interval: 60, nodes: [1, 2, 3, 4, 7, 8] },
    { id: 2, name: "备用入口", target: "backup.example.invalid:443", interval: 30, nodes: [1, 3, 6] },
    { id: 3, name: "对象存储", target: "s3.example.invalid:443", interval: 120, nodes: [2, 4, 9] },
    { id: 4, name: "DNS", target: "ns1.example.invalid:53", interval: 300, nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  ]
  const probes = probeList.map((p) => ({ ...p, name: localize(p.name) }))
  // Typical round trip from each node to each probe target, ms.
  const latency = {
    1: { 1: 38, 2: 72, 3: 44, 4: 212, 7: 31, 8: 118 },
    2: { 1: 51, 3: 12, 6: 164 },
    3: { 2: 9, 4: 18, 9: 131 },
    4: { 1: 2, 2: 3, 3: 2, 4: 4, 5: 6, 6: 3, 7: 2, 8: 5, 9: 7 },
  }

  const settings = {
    site_name: "romi",
    public_page: "on",
    public_default_view: "cards",
    admin_username: "admin",
    maintenance_days: "0",
    online_grace_minutes: "5",
    geolite_url: "https://geo.example.invalid/GeoLite2-Country.mmdb",
    retention_days: "30",
    notify_grace: "3",
    notify_traffic: "80",
    notify_expiry: "7",
    notify_login: "on",
    notify_telegram_chat: "-1000000000000",
    notify_telegram_text: "{{title}}\n{{message}}",
    notify_webhook_body: '{"text":"{{title}}\\n{{message}}"}',
    notify_telegram_token_set: true,
    notify_webhook_url_set: false,
    notify_webhook_headers_set: false,
  }

  const sessions = [
    { id: "s-3f9a", current: true, created_at: Math.round(now - 2 * HOUR - 14 * MIN) },
    { id: "s-81c2", current: false, created_at: Math.round(now - 3 * DAY - 5 * HOUR) },
    { id: "s-07de", current: false, created_at: Math.round(now - 11 * DAY - 1 * HOUR) },
  ]

  const db = {
    path: "/var/lib/romi/romi.duckdb",
    size: 124.8 * MiB,
    wal: 2.1 * MiB,
    free: 18.4 * MiB,
    oldest: Math.round(now - 30 * DAY),
    retention: 30,
    rows: { metric: 1284512, ping_record: 842110 },
    engine: "DuckDB v1.5.5",
    schema: 3,
    queue: {
      queued_ops_current: 3, queue_capacity: 4096, accepted_ops_total: 5821904, committed_ops_total: 5821901,
      refused_ops_total: 0, failed_ops_total: 0, batch_transactions_total: 412877, batch_ops_total: 5821901,
      max_batch_size: 64, average_batch_size: 14.1, queue_wait_us_avg: 820, transaction_us_avg: 2150,
    },
  }

  const geolite = { state: "complete", received: 9.3 * MiB, error: "", configured: true }

  window.romiFixtures = { nodes, probes, latency, settings, sessions, db, geolite, localize, version: "0.1.0", units: { KiB, MiB, GiB, TiB } }
})()
