import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { useField } from "@/components/ui/field"

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const field = useField()
  return <textarea {...field} data-slot="textarea" className={cn("w-full min-w-0 border border-input bg-popover px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:opacity-50", className)} {...props} />
}
