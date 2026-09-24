import { createContext, useContext, useId, type ReactNode } from "react"
import { Label } from "./label"

const FieldContext = createContext<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>({})
export const useField = () => useContext(FieldContext)

/**
 * `error` is a refusal the field cannot discover for itself -- one the hub
 * returns, such as a rejected current password. It replaces the hint in the
 * same slot and marks the control invalid, so the message stays attached to the
 * input it concerns rather than floating between two fields.
 */
export function Field({ label, hint, error, className = "", children }: { label: string; hint?: string; error?: string; className?: string; children: ReactNode }) {
  const id = useId()
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <FieldContext.Provider value={{ id, "aria-describedby": described, "aria-invalid": error ? true : undefined }}>
      <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
        <Label htmlFor={id}>{label}</Label>
        {children}
        {error
          ? <p id={`${id}-error`} role="alert" className="field-error">{error}</p>
          : hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
    </FieldContext.Provider>
  )
}
