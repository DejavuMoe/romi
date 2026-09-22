import { createContext, useContext, useId, type ReactNode } from "react"
import { Label } from "./label"

const FieldContext = createContext<{ id?: string; "aria-describedby"?: string }>({})
export const useField = () => useContext(FieldContext)

export function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  const id = useId()
  return (
    <FieldContext.Provider value={{ id, "aria-describedby": hint ? `${id}-hint` : undefined }}>
      <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
        <Label htmlFor={id}>{label}</Label>
        {children}
        {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
    </FieldContext.Provider>
  )
}
