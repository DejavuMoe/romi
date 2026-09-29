import { Input } from "./input"
import { parseDate } from "../../lib/calendar"

export function DatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Input type="text" placeholder="YYYY-MM-DD" value={value} aria-invalid={value.length>=10 && !parseDate(value)} onChange={event=>onChange(event.target.value)} />
}
