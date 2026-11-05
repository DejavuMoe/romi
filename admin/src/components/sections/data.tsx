import { useEffect, useRef, useState } from "react"

import { T } from "../../../../shared/i18n.ts"
import { api, upload } from "@/lib/api"
import { bytes } from "@/lib/format"
import { Button, Check, Field, Select } from "../../../../web/src/components/ui/controls"
import { Notice, toast } from "../../../../web/src/components/ui/feedback"
import { Icon } from "../../../../web/src/components/ui/icon"
import { Confirm, Dialog } from "../../../../web/src/components/ui/overlay"
import { Meter } from "../../../../web/src/components/ui/status"
import { full } from "../../../../web/src/lib/format"
import { cx } from "../../../../web/src/lib/hooks"

import { PageLoad, SectionCard, useSettings } from "./common"

type DbInfo = {
  path: string
  size: number
  wal: number
  free: number
  oldest: number | null
  retention: number
  rows: Record<string, number>
  engine: string
  schema: number | null
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

type RestorePhase = "confirm" | "upload" | "verify"

function bytesParts(value: number) {
  const text = bytes(value)
  const split = text.lastIndexOf(" ")
  return split < 0 ? { value: text, unit: "" } : { value: text.slice(0, split), unit: text.slice(split + 1) }
}

function RestoreDialog({ file, onClose, onDone }: { file: File; onClose: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<RestorePhase>("confirm")
  const [sent, setSent] = useState(0)
  const [kept, setKept] = useState(false)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  async function start() {
    if (!kept || phase !== "confirm") return
    setPhase("upload")
    setSent(0)
    abort.current = new AbortController()
    try {
      await upload("/db/restore", file, setSent, abort.current.signal, () => setPhase("verify"))
      toast(T("已恢复，正在重新加载"))
      onDone()
    } catch (e) {
      if ((e as Error).name === "AbortError") toast(T("已取消，数据库没有改动"), "info")
      else toast(T((e as Error).message), "bad")
      setPhase("confirm")
    } finally {
      abort.current = null
    }
  }

  function close() {
    if (phase === "verify") return
    if (phase === "upload") {
      abort.current?.abort()
      onClose()
      return
    }
    onClose()
  }

  const pct = file.size ? (sent / file.size) * 100 : 0
  return (
    <Dialog
      title={T("用备份覆盖当前数据？")}
      onClose={close}
      size="sm"
      footer={(
        <>
          <Button onClick={close} disabled={phase === "verify"}>{T("取消")}</Button>
          <Button kind="danger" onClick={() => void start()} busy={phase !== "confirm"} disabled={!kept}>
            {phase === "confirm"
              ? T("确认恢复")
              : phase === "upload"
                ? T("已上传 {sent} / {size}", { sent: bytes(sent), size: bytes(file.size) })
                : T("正在校验并切换")}
          </Button>
        </>
      )}
    >
      <p className="confirm-detail">
        {T("将用")} <b className="mono">{file.name}</b>
        {T("（{size}）整体替换当前数据库。当前的节点、设置和历史全部丢失，且无法撤销。恢复后所有登录会话结束。", { size: bytes(file.size) })}
      </p>
      <Check checked={kept} onChange={setKept} disabled={phase !== "confirm"}>{T("我已保留当前数据的备份")}</Check>
      {phase !== "confirm" && (
        <div className="progress-block" role="status">
          <span className="progress">
            <i style={{ width: `${phase === "verify" ? 100 : pct}%` }} data-verify={phase === "verify" ? true : undefined}></i>
          </span>
          <span className="muted small num">
            {phase === "upload" ? T("上传中 {pct}%", { pct: pct.toFixed(0) }) : T("校验归档与关系，完成后替换数据库")}
          </span>
        </div>
      )}
    </Dialog>
  )
}

export function Data() {
  const maintenance = useSettings()
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [dbError, setDbError] = useState("")
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [drag, setDrag] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    api<DbInfo>("/db", { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) { setInfo(next); setDbError("") } })
      .catch((e: Error) => { if (!controller.signal.aborted) setDbError(e.message || "网络错误") })
    return () => controller.abort()
  }, [reload])

  const settings = maintenance.s
  const [maint, setMaint] = useState("")
  const savedMaintenance = String(settings?.maintenance_days ?? "0")
  const maintenanceValue = maint === "" ? savedMaintenance : maint
  const pageError = dbError || maintenance.error
  const retry = () => { setDbError(""); setReload(value => value + 1); maintenance.retry() }

  function choose(next?: File | null) {
    if (!next) return
    if (!/\.(tar\.gz|tgz|gz)$/i.test(next.name)) {
      toast(T("请选择 .tar.gz 备份文件"), "bad")
      return
    }
    setFile(next)
  }

  async function runMaintenance() {
    setBusy("maintenance")
    try {
      const { pruned, freed, compacted, reusable } = await api<{
        pruned: number
        freed: number
        compacted: boolean
        reusable: number
      }>("/db/maintenance", { method: "POST" })
      toast(compacted
        ? T("已清理 {n} 行，重写文件后实际回收 {size}", { n: pruned.toLocaleString(), size: bytes(freed) })
        : T("已清理 {n} 行，可复用 {size} 未达重写阈值，本次未重写文件", { n: pruned.toLocaleString(), size: bytes(reusable) }))
      setReload(value => value + 1)
    } catch (e) {
      toast(T((e as Error).message), "bad")
    } finally {
      setBusy("")
      setConfirm(false)
    }
  }

  async function saveSchedule() {
    setBusy("schedule")
    const failure = await maintenance.save({ maintenance_days: maintenanceValue }, { success: T("已保存") })
    setBusy("")
    if (!failure) setMaint("")
  }

  if (!info || !settings) {
    return <PageLoad state={pageError ? "error" : "loading"} label={T("数据统计")} onRetry={retry} detail={T(pageError)}>{null}</PageLoad>
  }

  const db = info
  const q = db.queue
  const stored = bytesParts(db.size)
  const used = Math.max(0, db.size - db.free)
  return (
    <>
      {dbError && (
        <Notice tone="bad" action={<Button size="sm" onClick={retry}>{T("重试")}</Button>}>
          {T(dbError)}
        </Notice>
      )}
      {maintenance.error && <Notice tone="bad">{T(maintenance.error)}</Notice>}
      <div className="data-layout">
        <SectionCard
          id="db"
          title={T("数据库")}
          icon="database"
          aside={<span className="muted small">{db.engine} · schema {db.schema ?? "—"}</span>}
        >
          <div className="db-hero">
            <div>
              <p className="db-size num">{stored.value}<span className="unit">{stored.unit}</span></p>
              <p className="muted small mono">{db.path}</p>
            </div>
            <div className="db-bar" aria-hidden="true">
              <i style={{ flex: used }} className="db-used"></i>
              <i style={{ flex: db.free }} className="db-free"></i>
              <i style={{ flex: db.wal }} className="db-wal"></i>
            </div>
            <div className="db-legend">
              <span><i className="db-used"></i>{T("已用 {size}", { size: bytes(used) })}</span>
              <span><i className="db-free"></i>{T("可复用空间 {size}", { size: bytes(db.free) })}</span>
              <span><i className="db-wal"></i>{T("预写日志 {size}", { size: bytes(db.wal) })}</span>
            </div>
          </div>
          <dl className="stat-grid">
            <div><dt>{T("历史明细")}</dt><dd className="num">{(db.rows.metric ?? 0).toLocaleString()}</dd></div>
            <div><dt>{T("延迟记录")}</dt><dd className="num">{(db.rows.ping_record ?? 0).toLocaleString()}</dd></div>
            <div><dt>{T("最早记录")}</dt><dd className="num">{db.oldest ? full(db.oldest * 1000).slice(0, 10) : "—"}</dd></div>
            <div><dt>{T("分钟历史保留")}</dt><dd className="num">{T("{n} 天", { n: db.retention })}</dd></div>
          </dl>
        </SectionCard>

        <SectionCard id="backup" title={T("备份与恢复")} icon="file-archive">
          <div className="backup-row">
            <p className="muted">{T("备份包含凭据摘要，请勿公开。仅导入此处导出的备份文件。")}</p>
            <a className="btn btn-secondary" href="/api/db/backup" download>
              <Icon name="download" />
              <span className="btn-label">{T("下载备份")}</span>
            </a>
          </div>
          <button
            type="button"
            className={cx("dropzone", drag && "is-over")}
            onClick={() => picker.current?.click()}
            onDragOver={event => { event.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={event => { event.preventDefault(); setDrag(false); choose(event.dataTransfer.files[0]) }}
          >
            <Icon name="upload" size={24} />
            <span className="dropzone-title">{T("拖入备份文件，或点击选择")}</span>
            <span className="muted small">{T(".tar.gz · 验证通过前不会替换当前数据库")}</span>
          </button>
          <input
            ref={picker}
            type="file"
            accept=".gz,.tgz,.tar.gz,application/gzip"
            hidden
            onChange={event => { choose(event.target.files?.[0]); event.target.value = "" }}
          />
        </SectionCard>

        <SectionCard id="queue" title={T("写入队列")} icon="activity">
          <div className="queue">
            <div className="queue-gauge">
              <span className="muted small">{T("当前排队")}</span>
              <b className="num">{q.queued_ops_current} / {q.queue_capacity}</b>
              <Meter value={(q.queued_ops_current / q.queue_capacity) * 100} thin tone="neutral" />
            </div>
            <dl className="stat-grid stat-grid-sm">
              <div><dt>{T("已接收")}</dt><dd className="num">{q.accepted_ops_total.toLocaleString()}</dd></div>
              <div><dt>{T("已提交")}</dt><dd className="num">{q.committed_ops_total.toLocaleString()}</dd></div>
              <div><dt>{T("已拒绝")}</dt><dd className="num">{q.refused_ops_total}</dd></div>
              <div><dt>{T("失败")}</dt><dd className="num">{q.failed_ops_total}</dd></div>
              <div><dt>{T("平均批量")}</dt><dd className="num">{q.average_batch_size}</dd></div>
              <div><dt>{T("平均等待")}</dt><dd className="num">{(q.queue_wait_us_avg / 1000).toFixed(2)} ms</dd></div>
              <div><dt>{T("平均事务")}</dt><dd className="num">{(q.transaction_us_avg / 1000).toFixed(2)} ms</dd></div>
              <div><dt>{T("最大批量")}</dt><dd className="num">{q.max_batch_size}</dd></div>
            </dl>
          </div>
        </SectionCard>

        <SectionCard id="maintenance" title={T("维护")} icon="wrench">
          <p className="muted">{T("清理过期历史明细，累计流量保持不变。请预留至少与数据库等量的空闲磁盘。")}</p>
          <div className="maint-row">
            <Field label={T("自动维护周期")}>
              <Select value={maintenanceValue} onChange={event => setMaint(event.target.value)}>
                <option value="0">{T("关闭#off")}</option>
                {["7", "30", "90", "180"].map(days => (
                  <option key={days} value={days}>{T("每 {n} 天", { n: days })}</option>
                ))}
              </Select>
            </Field>
            <Button disabled={busy === "schedule" || maintenanceValue === savedMaintenance} busy={busy === "schedule"} onClick={() => void saveSchedule()}>
              {T("保存周期")}
            </Button>
          </div>
          <p className="muted small">
            {String(settings.maintenance_days ?? "0") === "0"
              ? T("自动维护已关闭")
              : T("已启用 · 每 {maintenance_days} 天，每小时检查一次是否到期", { maintenance_days: String(settings.maintenance_days) })}
          </p>
          <div className="divider"></div>
          <div className="maint-row">
            <div>
              <p className="danger-title">{T("立即维护")}</p>
              <p className="muted small">{T("维护期间写入可能短暂等待。")}</p>
            </div>
            <Button icon="wrench" busy={busy === "maintenance"} onClick={() => setConfirm(true)}>{T("运行维护")}</Button>
          </div>
        </SectionCard>
      </div>
      {confirm && (
        <ConfirmMaintenance
          busy={busy === "maintenance"}
          onClose={() => setConfirm(false)}
          onConfirm={() => void runMaintenance()}
        />
      )}
      {file && (
        <RestoreDialog
          file={file}
          onClose={() => setFile(null)}
          onDone={() => {
            setFile(null)
            setTimeout(() => location.reload(), 800)
          }}
        />
      )}
    </>
  )
}

function ConfirmMaintenance({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Confirm
      title={T("运行数据库维护？")}
      detail={T("将删除超出保留期的历史明细。累计流量不受影响，维护期间写入可能短暂等待。")}
      confirmLabel={T("运行维护")}
      danger={false}
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}
