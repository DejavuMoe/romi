import type { ReactNode } from "react"
import { usageTone } from "../../../shared/usage"

type Props = { label: ReactNode; pct: number | null; foot: ReactNode; empty?: ReactNode }

/**
 * One metric: name and percentage on top, bar in the middle, raw numbers
 * underneath. Color indicates the usage level; length and text carry its value.
 */
export function Meter({ label, pct, foot, empty = "—" }: Props) {
  // null means the metric has no ceiling to fill, so the bar stays empty rather
  // than reporting 0%. What replaces the percentage depends on the reason:
  // unknown for a node with no metrics, a text label for a plan with no limit.
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="resource-meter min-w-0" data-tone={usageTone(pct)}>
      <div className="resource-heading">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="usage-number tnum font-medium">
          {pct === null ? empty : `${filled.toFixed(0)}%`}
        </span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden bg-muted" aria-hidden="true">
        <div className="usage-fill h-full" style={{ width: `${filled}%` }} />
      </div>
      <div className="tnum mt-1 break-words text-[11px] leading-4 text-muted-foreground">{foot}</div>
    </div>
  )
}
