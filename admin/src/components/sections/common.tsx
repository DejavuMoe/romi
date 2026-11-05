import { useEffect, useId, useState, type ReactNode } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { addresses, api, ApiError, type Node } from "@/lib/api"
import { T } from "../../../../shared/i18n.ts"
import { Empty, Skeleton as V15Skeleton, toast as v15Toast } from "../../../../web/src/components/ui/feedback"
import { Icon, type IconName } from "../../../../web/src/components/ui/icon"
import { cx } from "../../../../web/src/lib/hooks"

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
        </DialogHeader>
        <DialogDescription className="leading-relaxed">{description}</DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function LoadState({ error, retry }: { error: string; retry: () => void }) {
  return error ? (
    <div className="load-state">
      <span className="load-state-mark" aria-hidden="true">[ ! ]</span>
      <div role="alert"><p className="load-state-title">加载失败</p><p>{error}</p></div>
      <Button variant="outline" size="sm" onClick={retry}>重试</Button>
    </div>
  ) : (
    <div role="status" aria-label="加载中">
      <Skeleton className="h-32" />
    </div>
  )
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="load-state" role="status">
      <span className="load-state-mark is-empty" aria-hidden="true">[ — ]</span>
      <p className="load-state-title">{title}</p>
      {detail && <p>{detail}</p>}
    </div>
  )
}

export function SectionCard({ id, title, icon, aside, className, children }: {
  id?: string
  title?: ReactNode
  icon?: IconName
  aside?: ReactNode
  className?: string
  children: ReactNode
}) {
  const own = useId()
  const titleId = id ?? own
  return (
    <section className={cx("card", className)} aria-labelledby={title ? titleId : undefined}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2 id={titleId} className="card-title">{icon && <Icon name={icon} size={16} />}{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

/** The shared loading/error frame for the sections migrated from the prototype. */
export function PageLoad({ state, label, onRetry, detail, children }: {
  state: "loading" | "error" | "ready"
  label: string
  onRetry: () => void
  detail?: ReactNode
  children: ReactNode
}) {
  if (state === "loading") return (
    <div className="stack-page" role="status" aria-label={T("正在加载")}>
      <V15Skeleton style={{ height: 180 }} />
      <V15Skeleton style={{ height: 260 }} />
    </div>
  )
  if (state === "error") return (
    <Empty error title={T("{label}加载失败", { label })} detail={detail ?? T("请求失败，未改变任何数据。")} action={T("重试")} onAction={onRetry} />
  )
  return children
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
    save: async (patch: Record<string, string>, options: { success?: string; quietStatus?: number } = {}): Promise<Error | null> => {
      setError("")
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify(patch) })
        v15Toast(options.success ?? T("已保存"))
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
        const error = e as Error
        // A refusal that belongs on one field (the current password) must not
        // also become a page-level error or a toast: S-2 says that field is the
        // only place it appears.
        const quiet = options.quietStatus !== undefined && e instanceof ApiError && e.status === options.quietStatus
        if (!quiet) {
          setError(error.message)
          v15Toast(error.message, "bad")
        }
        return error
      }
    },
  }
}
