import { useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Popover } from "radix-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useField } from "@/components/ui/field"
import { dateKey, monthDays, parseDate } from "@/lib/calendar"

export function DatePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const field = useField()
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => parseDate(value) ?? new Date())
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)
  const grid = useRef<HTMLDivElement>(null)
  const today = dateKey(new Date())
  const choose = (next: string) => { onChange(next); setOpen(false) }
  const moveMonth = (by: number) => setMonth(() => { const next = new Date(month); next.setDate(1); next.setMonth(next.getMonth() + by); return next })

  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      if (next) { setMonth(parseDate(value) ?? new Date()); setDraft(value); setInvalid(false) }
      setOpen(next)
    }}>
      <Popover.Trigger asChild>
        <Button {...field} type="button" variant="outline" className="w-full justify-between font-normal">
          <span className={value ? "" : "text-muted-foreground"}>{value || "永不到期"}</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label="选择到期日期" align="end" sideOffset={6} collisionPadding={12} className="z-[60] flex max-h-[var(--radix-popover-content-available-height)] overflow-y-auto w-72 max-w-[calc(100vw-24px)] flex-col gap-3 border bg-popover p-3 text-popover-foreground outline-none" onOpenAutoFocus={(e) => { e.preventDefault(); (grid.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"], [aria-current="date"]') ?? grid.current?.querySelector<HTMLButtonElement>('button'))?.focus() }}>
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="上个月" disabled={month.getFullYear() === 1 && month.getMonth() === 0} onClick={() => moveMonth(-1)}><ChevronLeft /></Button>
            <span aria-live="polite" className="text-sm font-medium">{month.getFullYear()} 年 {month.getMonth() + 1} 月</span>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="下个月" disabled={month.getFullYear() === 9999 && month.getMonth() === 11} onClick={() => moveMonth(1)}><ChevronRight /></Button>
          </div>
          <div className="grid grid-cols-7 text-center text-xs text-muted-foreground" aria-hidden="true">
            {["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}
          </div>
          <div ref={grid} className="grid grid-cols-7 gap-1" role="group" aria-label="日期" onKeyDown={(e) => {
            const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key]
            if (!offset) return
            const current = parseDate((e.target as HTMLElement).dataset.date ?? "")
            if (!current) return
            e.preventDefault()
            current.setDate(current.getDate() + offset)
            if (current.getFullYear() < 1 || current.getFullYear() > 9999) return
            setMonth(current)
            requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-date="${dateKey(current)}"]`)?.focus())
          }}>
            {monthDays(month).map((day, i) => {
              if (!day) return <span key={`empty-${i}`} />
              const key = dateKey(day)
              return <button key={key} type="button" data-date={key} aria-label={key} aria-pressed={key === value} aria-current={key === today ? "date" : undefined} className={`flex h-8 min-w-0 items-center justify-center border text-sm hover:bg-accent ${key === value ? "border-primary bg-primary text-primary-foreground hover:bg-primary" : key === today ? "border-primary text-primary" : "border-transparent"}`} onClick={() => choose(key)}>{day.getDate()}</button>
            })}
          </div>
          <div className="flex flex-col gap-2 border-t pt-3">
            <label htmlFor={`${field.id}-typed`} className="text-xs text-muted-foreground">输入日期（YYYY-MM-DD）</label>
            <div className="flex gap-2">
              <Input id={`${field.id}-typed`} aria-describedby={invalid ? `${field.id}-error` : undefined} aria-invalid={invalid} value={draft} placeholder="2026-09-17" onChange={e => { setDraft(e.target.value); setInvalid(false) }} onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); if (!draft || parseDate(draft)) choose(draft); else setInvalid(true) }
              }} />
              <Button type="button" size="sm" onClick={() => { if (!draft || parseDate(draft)) choose(draft); else setInvalid(true) }}>确定</Button>
            </div>
            {invalid && <p id={`${field.id}-error`} role="alert" className="text-xs text-destructive">请输入有效日期，例如 2026-09-17</p>}
          </div>
          <div className="flex justify-between gap-2 border-t pt-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => choose(today)}>今天</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => choose("")}>清除日期</Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
