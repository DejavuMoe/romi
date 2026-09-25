import { useEffect, useState } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { addresses, api, type Node } from "@/lib/api"

export function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("已复制"),
    () => toast.error("复制失败"),
  )
}

export function CopyValue({ value, label }: { value?: string; label: string }) {
  return value ? <button type="button" className="copy-value" aria-label={`复制 ${label}`} onClick={() => copy(value)}><span>{value}</span><Copy className="copy-mark" aria-hidden="true" /></button> : <span className="text-muted-foreground">未上报</span>
}

export function Addresses({ node }: { node: Node }) {
  return <div>{addresses(node).map(address => <CopyValue key={address} value={address} label={address} />)}</div>
}

export type ReturnFocus = { onCloseAutoFocus?: (event: Event) => void }

export function ConfirmDialog({ title, description, confirmLabel, busy = false, onClose, onConfirm, onCloseAutoFocus }: {
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
} & ReturnFocus) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t pt-4">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function LoadState({ error, retry }: { error: string; retry: () => void }) {
  return error ? (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-destructive" role="alert">加载失败：{error}</p>
      <Button variant="outline" size="sm" onClick={retry}>重试</Button>
    </div>
  ) : (
    <div role="status" aria-label="加载中">
      <Skeleton className="h-32" />
    </div>
  )
}

export type Settings = Record<string,string|boolean>
export function useSettings() {
  const [saved,setSaved]=useState<Settings>({})
  const [s, setS] = useState<Settings | null>(null)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<Settings>("/settings", { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) {setS(next);setSaved(next)} })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message || "网络错误") })
    return () => controller.abort()
  }, [reload])
  return {
    s,
    dirty:(keys:string[])=>keys.some(k=>(s?.[k]??"")!==(saved[k]??"")),
    error,
    retry: () => { setError(""); setReload((n) => n + 1) },
    set: (k: string, v: string) => setS((old) => ({ ...(old ?? {}), [k]: v })),
    // `null` when the save landed, otherwise the refusal. The errors are
    // reported here, so callers need not, but a caller that discards what it
    // just sent -- the password fields -- has to tell a rejection from a
    // success, and one that attributes a refusal to a particular field needs
    // its status.
    save: async (patch: Record<string, string>): Promise<Error | null> => {
      setError("")
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify(patch) })
        toast.success("已保存")
        // Only the saved keys and the `*_set` flags are taken from the hub: a
        // credential comes back as a flag, so the typed value must not linger,
        // while another card's unsaved edits on the same page must survive.
        const fresh = await api<Settings>("/settings")
        setSaved(fresh)
        setS((old) => {
          const next = { ...old }
          for (const key of Object.keys(patch)) next[key] = fresh[key]
          for (const [key, value] of Object.entries(fresh)) if (key.endsWith("_set")) next[key] = value
          return next
        })
        return null
      } catch (e) {
        setError((e as Error).message)
        toast.error((e as Error).message)
        return e as Error
      }
    },
  }
}
