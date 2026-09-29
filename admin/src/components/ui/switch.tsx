import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

type Props = Omit<ComponentProps<"input">, "type" | "onChange" | "size"> & {
  size?: "sm" | "default"
  onCheckedChange?: (checked: boolean) => void
}
function Switch({ className, size = "default", onCheckedChange, ...props }: Props) {
  return <input {...props} type="checkbox" data-slot="switch" data-size={size} className={cn("choice-checkbox", className)} onChange={event => onCheckedChange?.(event.target.checked)} />
}
export { Switch }
