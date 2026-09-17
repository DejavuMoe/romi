import { Card } from "@/components/ui/card"
import { speedHistory, type Node } from "@/lib/api"
import { bytes, rate } from "@/lib/format"
import { cn } from "@/lib/utils"

function Tile({ label, children }: {
  label: string; children: React.ReactNode
}) {
  return (
    <Card className="gap-0 border-0 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
      </div>
      {children}
    </Card>
  )
}

/**
 * In and out side by side, the form every traffic figure on this page takes.
 * Stacked below sm, where two tiles share a phone's width and "23.3 MB" has
 * roughly 70px available.
 */
function Flow({ down, up, className }: { down: string; up: string; className?: string }) {
  return (
    <div className={cn("tnum grid grid-cols-1 gap-x-2 sm:grid-cols-2 min-[56.25rem]:grid-cols-1 min-[70rem]:grid-cols-2", className)}>
      <span className="inline-flex items-center gap-1">
        <span className="shrink-0 text-xs font-normal text-muted-foreground">下行</span>
        <span className="whitespace-nowrap">{down}</span>
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="shrink-0 text-xs font-normal text-muted-foreground">上行</span>
        <span className="whitespace-nowrap">{up}</span>
      </span>
    </div>
  )
}

/**
 * A bare polyline with no axes or tooltips: at this size only the shape is
 * legible, and recharts would bring a full chart's machinery for it. Series share
 * one scale so the two throughput lines remain comparable.
 */
function Spark({ series }: { series: { values: number[]; className: string }[] }) {
  const top = Math.max(...series.flatMap((s) => s.values), 1)
  const width = Math.max(...series.map((s) => s.values.length), 2) - 1
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      {series.map((s, i) => (
        <polyline
          key={i}
          className={s.className}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          points={s.values.map((v, x) => `${(x / width) * 100},${23 - (v / top) * 22}`).join(" ")}
        />
      ))}
    </svg>
  )
}

export function Summary({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((n) => n.online)
  const sum = (pick: (n: Node) => number) => nodes.reduce((total, n) => total + pick(n), 0)

  // The busiest node rather than the average: one machine at 95% is what matters,
  // and a fleet of idle ones would average it away.
  const busiest = online.reduce<Node | null>(
    (top, n) => (n.metrics && (!top || n.metrics.cpu > top.metrics!.cpu) ? n : top),
    null,
  )
  const cpu = busiest?.metrics?.cpu ?? 0
  // The same push produced `nodes` and this sample, so the figure above the line
  // is that line's last point.
  const now = speedHistory.at(-1) ?? { rx: 0, tx: 0 }

  return (
    <div className="grid grid-cols-2 border-y [&>*:nth-child(even)]:border-l min-[56.25rem]:grid-cols-4 min-[56.25rem]:[&>*+*]:border-l">
      <Tile label="节点">
        <div className="tnum mt-1 text-xl font-semibold">
          {online.length} / {nodes.length}
        </div>
        <div className="mt-auto pt-1 text-xs text-muted-foreground">
          {nodes.length - online.length > 0 ? `${nodes.length - online.length} 个离线` : "全部在线"}
        </div>
      </Tile>

      <Tile label="最忙节点">
        <div className="tnum mt-1 text-xl font-semibold">{busiest ? `${cpu.toFixed(1)}%` : "—"}</div>
        <div className={cn("mt-auto truncate pt-1 text-xs", cpu >= 85 ? "font-medium text-foreground" : "text-muted-foreground")}>
          {busiest ? busiest.name : "无在线节点"}
        </div>
      </Tile>

      <Tile label="今日流量">
        <Flow
          down={bytes(sum((n) => n.day_rx))}
          up={bytes(sum((n) => n.day_tx))}
          className="mt-1 text-xs font-semibold sm:text-sm"
        />
        <div className="mt-2 text-xs text-muted-foreground">总流量</div>
        <Flow down={bytes(sum((n) => n.total_rx))} up={bytes(sum((n) => n.total_tx))} className="mt-0.5 text-xs sm:text-sm" />
      </Tile>

      <Tile label="实时网速">
        <Flow down={rate(now.rx)} up={rate(now.tx)} className="mt-1 text-xs font-semibold sm:text-sm" />
        <div className="mt-auto pt-1">
          <Spark
            series={[
              { values: speedHistory.map((s) => s.rx), className: "text-chart-2" },
              { values: speedHistory.map((s) => s.tx), className: "text-chart-1" },
            ]}
          />
        </div>
      </Tile>
    </div>
  )
}
