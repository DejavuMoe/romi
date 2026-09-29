/** Shared visual levels; these are not notification thresholds. */
export function usageTone(value: number | null | undefined): "unknown" | "normal" | "warning" | "critical" {
  return value == null || !Number.isFinite(value) ? "unknown" : value >= 85 ? "critical" : value >= 60 ? "warning" : "normal"
}
