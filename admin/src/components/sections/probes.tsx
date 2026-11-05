import { useEffect, useState } from "react"

import { T } from "../../../../shared/i18n.ts"
import { connection, connectionLabel, type Node } from "../../../../shared/nodes.ts"
import { countryName } from "../../../../shared/geo.ts"
import { numericError } from "../../../../shared/validate.ts"
import { api, type PingTask } from "@/lib/api"
import { Button, Check, Field, IconButton, Input } from "../../../../web/src/components/ui/controls"
import { Empty, toast } from "../../../../web/src/components/ui/feedback"
import { Icon } from "../../../../web/src/components/ui/icon"
import { Confirm, Dialog } from "../../../../web/src/components/ui/overlay"
import { StatusDot } from "../../../../web/src/components/ui/status"

import { PageLoad } from "./common"

/** The hub's target rule: host:port, with brackets required around IPv6. */
function validTarget(target: string): boolean {
  let host = ""
  let port = ""
  if (target.startsWith("[")) {
    const end = target.indexOf("]:")
    if (end < 0) return false
    host = target.slice(1, end)
    port = target.slice(end + 2)
  } else {
    const colon = target.lastIndexOf(":")
    if (colon < 0) return false
    host = target.slice(0, colon)
    port = target.slice(colon + 1)
    if (host.includes(":")) return false
  }
  return host.length > 0 && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535
}

function NodeChips({ ids, nodes, max = 4 }: { ids: number[]; nodes: Node[]; max?: number }) {
  const list = ids.map(id => nodes.find(node => node.id === id)).filter((node): node is Node => !!node)
  return (
    <span className="node-chips">
      {list.slice(0, max).map(node => (
        <span key={node.id} className="node-chip">
          <StatusDot status={connection(node)} />
          <span>{node.name}</span>
        </span>
      ))}
      {list.length > max && <span className="node-chip node-chip-more">+{list.length - max}</span>}
    </span>
  )
}

function ProbeDialog({ probe, nodes, busy, onClose, onSave }: {
  probe: PingTask | null
  nodes: Node[]
  busy: boolean
  onClose: () => void
  onSave: (task: PingTask) => void
}) {
  const [v, setV] = useState({
    name: probe?.name ?? "",
    target: probe?.target ?? "",
    interval: String(probe?.interval ?? 60),
    nodes: probe ? probe.nodes.filter(id => nodes.some(node => node.id === id)) : nodes.filter(node => node.online).map(node => node.id),
  })
  const [tried, setTried] = useState(false)
  const [intervalTouched, setIntervalTouched] = useState(false)
  const [q, setQ] = useState("")
  const set = (key: "name" | "target" | "interval", value: string) => setV(old => ({ ...old, [key]: value }))
  const errors = {
    name: v.name.trim() ? "" : T("请填写名称"),
    target: !v.target.trim() ? T("请填写目标地址") : validTarget(v.target.trim()) ? "" : T("请输入 host:port，例如 1.1.1.1:443"),
    interval: numericError(v.interval, { min: 5, max: 3600, required: true }),
  }
  const invalid = Object.values(errors).some(Boolean)
  const shown = nodes.filter(node => node.name.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: number) => setV(old => ({
    ...old,
    nodes: old.nodes.includes(id) ? old.nodes.filter(value => value !== id) : [...old.nodes, id],
  }))
  return (
    <Dialog
      title={probe ? T("编辑监测") : T("添加监测")}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>{T("取消")}</Button>
        <Button kind="primary" type="submit" form="probe-form" busy={busy}>{T("保存")}</Button>
      </>}
    >
      <form
        id="probe-form"
        className="inspector-form"
        noValidate
        onSubmit={e => {
          e.preventDefault()
          setTried(true)
          if (invalid) return
          onSave({ id: probe?.id ?? 0, name: v.name.trim(), target: v.target.trim(), interval: Number(v.interval), nodes: v.nodes })
        }}
      >
        <div className="form-grid">
          <Field label={T("名称")} error={tried ? errors.name : ""}>
            <Input data-autofocus={probe ? undefined : true} value={v.name} placeholder="Cloudflare" onChange={e => set("name", e.target.value)} />
          </Field>
          <Field label={T("间隔（秒）")} hint="5–3600" error={intervalTouched || tried ? errors.interval : ""}>
            <Input
              inputMode="numeric"
              value={v.interval}
              onChange={e => set("interval", e.target.value)}
              onBlur={() => setIntervalTouched(true)}
            />
          </Field>
        </div>
        <Field label={T("目标地址")} hint="host:port" error={tried ? errors.target : ""}>
          <Input className="mono" value={v.target} placeholder="1.1.1.1:443" onChange={e => set("target", e.target.value)} />
        </Field>
        <fieldset className="form-set">
          <legend>{T("执行节点")} <span className="muted num">{v.nodes.length} / {nodes.length}</span></legend>
          <div className="picker-tools">
            <label className="search-field">
              <Icon name="search" />
              <input type="search" aria-label={T("筛选节点")} placeholder={T("筛选节点")} value={q} onChange={e => setQ(e.target.value)} />
            </label>
            <button type="button" className="link-button" onClick={() => setV(old => ({ ...old, nodes: nodes.map(node => node.id) }))}>{T("全选")}</button>
            <button type="button" className="link-button" onClick={() => setV(old => ({ ...old, nodes: nodes.filter(node => node.online).map(node => node.id) }))}>{T("仅在线")}</button>
            <button type="button" className="link-button" onClick={() => setV(old => ({ ...old, nodes: [] }))}>{T("清空")}</button>
          </div>
          <div className="picker-list">
            {shown.map(node => (
              <Check
                key={node.id}
                checked={v.nodes.includes(node.id)}
                onChange={() => toggle(node.id)}
                detail={[countryName(node.country), connectionLabel(node)].filter(Boolean).join(" · ")}
              >
                {node.name}
              </Check>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}

export function Ping({ nodes }: { nodes: Node[] }) {
  const [tasks, setTasks] = useState<PingTask[] | null>(null)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<PingTask | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<PingTask | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  const load = () => {
    setTasks(null)
    setError("")
    setReload(value => value + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    api<{ tasks: PingTask[] }>("/ping-tasks", { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setTasks(data.tasks) })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message || T("网络错误")) })
    return () => controller.abort()
  }, [reload])

  const list = tasks ?? []
  const state = tasks === null ? (error ? "error" : "loading") : "ready"
  const add = () => { setEditing(null); setDialogOpen(true) }
  const edit = (task: PingTask) => { setEditing(task); setDialogOpen(true) }

  async function save(task: PingTask) {
    setSaving(true)
    try {
      await api("/ping-tasks", { method: "POST", body: JSON.stringify(task) })
      toast(T("已保存，正在下发"))
      setDialogOpen(false)
      setEditing(null)
      load()
    } catch (e) {
      toast(T((e as Error).message), "bad")
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/ping-tasks/${deleting.id}`, { method: "DELETE" })
      toast(T("监控已删除"))
      setDeleting(null)
      load()
    } catch (e) {
      toast(T((e as Error).message), "bad")
    } finally {
      setRemoving(false)
    }
  }

  return (
    <PageLoad state={state} label={T("监测")} onRetry={load} detail={T(error)}>
      <div className="stack-page">
        <div className="toolbar">
          <p className="toolbar-text num">{T("{n} 个监测任务", { n: list.length })}</p>
          <div className="toolbar-end">
            <Button kind="primary" icon="plus" onClick={add}>{T("添加监测")}</Button>
          </div>
        </div>
        {!list.length ? (
          <Empty icon="radar" title={T("还没有监测任务")} detail={T("添加目标地址并选择节点。")} action={T("添加监测")} onAction={add} />
        ) : (
          <div className="probe-grid">
            {list.map(task => (
              <article key={task.id} className="probe-card">
                <div className="probe-head">
                  <span className="probe-icon"><Icon name="radar" size={20} /></span>
                  <div className="probe-title">
                    <h3>{task.name}</h3>
                    <p className="mono">{task.target}</p>
                  </div>
                  <div className="probe-actions">
                    <IconButton label={T("编辑 {name}", { name: task.name })} icon="pencil" onClick={() => edit(task)} tip="top" />
                    <IconButton label={T("删除 {name}", { name: task.name })} icon="trash-2" onClick={() => setDeleting(task)} tip="top" />
                  </div>
                </div>
                <dl className="probe-facts">
                  <div><dt>{T("间隔")}</dt><dd className="num">{T("{n} 秒", { n: task.interval })}</dd></div>
                  <div><dt>{T("执行节点")}</dt><dd className="num">{T("{n} 个", { n: task.nodes.length })}</dd></div>
                </dl>
                <NodeChips ids={task.nodes} nodes={nodes} />
              </article>
            ))}
          </div>
        )}
      </div>
      {dialogOpen && (
        <ProbeDialog
          probe={editing}
          nodes={nodes}
          busy={saving}
          onClose={() => { setDialogOpen(false); setEditing(null) }}
          onSave={save}
        />
      )}
      {deleting && (
        <Confirm
          title={T("删除监测「{name}」？", { name: deleting.name })}
          detail={T("该监控及其历史延迟记录一并删除，不可恢复。")}
          confirmLabel={T("删除监测")}
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </PageLoad>
  )
}
