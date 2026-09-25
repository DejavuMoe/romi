import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, upload } from "@/lib/api"
import { bytes } from "@/lib/format"

import { ConfirmDialog, LoadState, useSettings } from "./common"

type DbInfo = {
  path: string
  size: number
  wal: number
  /** Space DuckDB reports as reusable inside the file. Reclaimed only by a rewrite. */
  free: number
  /** Timestamp of the earliest history row, null on a database with none. */
  oldest: number | null
  retention: number
  rows: Record<string, number>
  /** The storage engine and the application schema it is running, for the record. */
  engine: string
  schema: number | null
  /** Writer-queue counters. `committed_ops_total` counts operations, not batches. */
  queue: {
    queued_ops_current: number
    queue_capacity: number
    accepted_ops_total: number
    committed_ops_total: number
    refused_ops_total: number
    failed_ops_total: number
    batch_transactions_total: number
    batch_ops_total: number
    max_batch_size: number
    average_batch_size: number
    queue_wait_us_avg: number
    transaction_us_avg: number
  }
}

// The only two tables whose row count indicates anything about size. Every other
// holds one row per node or per key.
const DB_ROWS: [string, string][] = [
  ["metric", "历史明细"],
  ["ping_record", "延迟记录"],
]

export function Data() {
  const maintenanceSettings=useSettings()
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [confirm, setConfirm] = useState<"maintenance" | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  // Closing the dialog must stop the upload rather than merely hide it: restore
  // is the one irreversible action here, and it takes minutes on a large
  // backup.
  const abort = useRef<AbortController | null>(null)
  // Leaving the section stops an unfinished restore, as the dialog's cancel
  // does. Otherwise it ran on unseen, replaced the database, and reloaded the
  // page under whatever the operator had moved on to.
  useEffect(() => () => abort.current?.abort(), [])
  const picker = useRef<HTMLInputElement>(null)

  const load = () => api<DbInfo>("/db").then((data) => { setInfo(data); setError("") }).catch((e: Error) => setError(e.message || "网络错误"))
  useEffect(() => { load() }, [])

  async function maintenance() {
    setBusy("maintenance")
    try {
      const { pruned, freed, compacted, reusable } = await api<{
        pruned: number
        freed: number
        compacted: boolean
        reusable: number
      }>("/db/maintenance", { method: "POST" })
      // `freed` is measured, not estimated: it is the difference in bytes on disk
      // before and after. When a rewrite was not worth it the count says so rather
      // than inventing a figure.
      toast.success(
        compacted
          ? `已清理 ${pruned} 行，重写文件后实际回收 ${bytes(freed)}`
          : `已清理 ${pruned} 行，可复用 ${bytes(reusable)} 未达重写阈值，本次未重写文件`,
      )
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setConfirm(null)
    }
  }

  async function restore(file: File) {
    setBusy("restore")
    setSent(0)
    abort.current = new AbortController()
    try {
      await upload("/db/restore", file, setSent, abort.current.signal)
      toast.success("已恢复，正在重新加载")
      // Every node, setting and session on the page came from the database just
      // replaced.
      setTimeout(() => location.reload(), 800)
    } catch (e) {
      // Aborting partway is not a failure: the hub replaces nothing until the
      // last chunk, so the original database remains.
      const aborted = (e as Error).name === "AbortError"
      if (aborted) toast.info("已取消，数据库没有改动")
      else toast.error((e as Error).message)
      setBusy("")
    }
    setPending(null)
  }

  if (!info) return <LoadState error={error} retry={load} />
  const stat = (label: string, value: string) => (
    <div key={label}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 text-sm">{value}</div>
    </div>
  )

  return (
    <div className="space-y-4">
      {error && <LoadState error={error} retry={load} />}
      <Card>
        <h3 className="text-sm font-medium">数据库</h3>
        <div className="stat-grid">
          {stat("文件大小", bytes(info.size))}
          {stat("预写日志", bytes(info.wal))}
          {stat("可复用空间", bytes(info.free))}
          {stat("保留天数", `${info.retention} 天`)}
          {/* 和保留天数并排：跨度小于保留期是还没攒够，大于保留期就是每小时
              那次 prune 没在跑。 */}
          {stat("历史跨度", info.oldest ? `${Math.floor((Date.now() / 1000 - info.oldest) / 86400)} 天` : "—")}
          {DB_ROWS.map(([key, label]) => stat(label, (info.rows[key] ?? 0).toLocaleString()))}
        </div>

      </Card>

      <Card>
        <div>
          <h3 className="text-sm font-medium">数据库维护</h3>
          {maintenanceSettings.s && <div className="my-4 flex items-end gap-3"><Field label="自动维护周期"><Select value={String(maintenanceSettings.s.maintenance_days || "0")} onValueChange={v=>maintenanceSettings.set("maintenance_days",v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{[0,7,30,90,180].map(n=><SelectItem key={n} value={String(n)}>{n ? `每 ${n} 天` : "关闭"}</SelectItem>)}</SelectContent></Select></Field><Button onClick={()=>maintenanceSettings.save({maintenance_days:String(maintenanceSettings.s?.maintenance_days || "0")})}>保存周期</Button></div>}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            清理过期历史明细，累计流量保持不变。请预留至少与数据库等量的空闲磁盘；维护期间写入可能短暂等待。
          </p>
        </div>
        <div>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirm("maintenance")}>
            {busy === "maintenance" ? "维护中…" : "立即维护"}
          </Button>
        </div>
      </Card>

      <Card>
        <div>
          <h3 className="text-sm font-medium">备份</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            备份包含凭据摘要，请勿公开。仅导入此处导出的备份文件；恢复会替换节点、设置和历史，并使所有登录失效。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* The browser's own download: the file is streamed straight from
              the response, never held in the page. */}
          <Button size="sm" asChild>
            <a href="/api/db/backup" download>
              导出备份
            </a>
          </Button>
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => picker.current?.click()}>
            导入备份
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              setPending(e.target.files?.[0] ?? null)
              e.target.value = ""
            }}
          />
        </div>
      </Card>

      {confirm === "maintenance" && (
        <ConfirmDialog
          title="运行数据库维护？"
          description="将删除超出保留期的历史明细。累计流量不受影响，维护期间写入可能短暂等待。"
          confirmLabel="开始维护"
          busy={!!busy}
          onClose={() => setConfirm(null)}
          onConfirm={maintenance}
        />
      )}
      {pending && (
        <ConfirmDialog
          title="用备份覆盖当前数据？"
          description={`将用 ${pending.name}（${bytes(pending.size)}）整体替换当前数据库。当前的节点、设置和历史全部丢失，且无法撤销。`}
          confirmLabel={busy === "restore" ? `已上传 ${bytes(sent)} / ${bytes(pending.size)}` : "确认恢复"}
          busy={!!busy}
          onClose={() => { abort.current?.abort(); setPending(null) }}
          onConfirm={() => restore(pending)}
        />
      )}
    </div>
  )
}
