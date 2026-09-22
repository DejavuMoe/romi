/** Local calendar dates: never round-trip through UTC (which can change the day). */
export function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(12, 0, 0, 0)
  return year > 0 && dateKey(date) === value ? date : null
}

export function monthDays(date: Date): (Date | null)[] {
  const first = new Date(date)
  first.setDate(1)
  const last = new Date(first)
  last.setMonth(last.getMonth() + 1, 0)
  return [...Array.from({ length: (first.getDay() + 6) % 7 }, () => null), ...Array.from({ length: last.getDate() }, (_, i) => {
    const day = new Date(first)
    day.setDate(i + 1)
    return day
  })]
}
