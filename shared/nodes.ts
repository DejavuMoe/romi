export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  zram_used?: number | null
  zram_total?: number | null
  zram_devices?: number | null
  swap_disk_used?: number | null
  swap_disk_total?: number | null
  swapfile_used?: number | null
  swap_partition_used?: number | null
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  priority?: number
  bandwidth_up?: number
  bandwidth_down?: number
  has_ipv4?: boolean
  has_ipv6?: boolean
  online_grace_minutes?: number
  online_since?: number
  traffic_unit?: string
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel only. */
  hostname?: string
  ip?: string
  ipv4?: string
  ipv6?: string
  notify?: boolean
  remark?: string
}


export function connectionLabel(node: Pick<Node,"online"|"last_seen"|"online_grace_minutes">, now=Date.now()/1000):string {
  if(node.online)return "在线"
  if(!node.last_seen)return "未连接"
  return now-node.last_seen<=(node.online_grace_minutes??5)*60 ? "重连中" : "离线"
}
