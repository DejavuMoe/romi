import type { ReactNode } from "react"

type Props = { label: ReactNode; pct: number | null; foot: ReactNode; empty?: ReactNode; color?: string }

/**
 * One metric: name and percentage on top, bar in the middle, raw numbers
 * underneath. Color identifies the metric while length and text carry its value.
 */
export function Meter({ label, pct, foot, empty = "—", color = "var(--primary)" }: Props) {
  // null means the metric has no ceiling to fill, so the bar stays empty rather
  // than reporting 0%. What replaces the percentage depends on the reason:
  // unknown for a node with no metrics, a text label for a plan with no limit.
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className="tnum text-xs font-medium">
          {pct === null ? empty : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`}
        </span>
      </div>
      <div className="mt-1 h-[3px] w-full overflow-hidden bg-muted">
        <div className="h-full transition-[width] duration-500" style={{ width: `${filled}%`, backgroundColor: color }} />
      </div>
      <div className="tnum mt-1 break-words text-[11px] leading-4 text-muted-foreground">{foot}</div>
    </div>
  )
}
