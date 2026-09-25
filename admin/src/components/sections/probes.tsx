import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type Node, type PingTask } from "@/lib/api"
import { numericError } from "../../../../shared/validate"

import { ConfirmDialog, LoadState } from "./common"

export function Ping({ nodes }: { nodes: Node[] }) {
  const [tasks, setTasks] = useState<PingTask[] | null>(null)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  // `intervalText` is what is typed in the interval box. The number alone cannot
  // tell an emptied box from 0, and the two read differently: "请填写此项" and
  // "不能小于 5".
  const [editing, setEditing] = useState<(Partial<PingTask> & { intervalText?: string }) | null>(null)
  const [intervalError, setIntervalError] = useState("")
  const intervalText = editing?.intervalText ?? String(editing?.interval ?? 60)
  const checkInterval = (raw: string) => numericError(raw, { min: 5, max: 3600, required: true })
  const [deleting, setDeleting] = useState<PingTask | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  const load = () => {
    setTasks(null)
    setError("")
    setReload((n) => n + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    api<{ tasks: PingTask[] }>("/ping-tasks", { signal: controller.signal })
      .then((d) => { if (!controller.signal.aborted) setTasks(d.tasks) })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message || "网络错误") })
    return () => controller.abort()
  }, [reload])

  async function save() {
    if (!editing) return
    if (!editing.name?.trim() || !editing.target?.trim()) return toast.error("请填写名称和目标")
    // Checked here, on the field, before the round trip: the hub refuses the
    // same values, but in English and after the dialog has already been sent.
    const refused = checkInterval(intervalText)
    setIntervalError(refused)
    if (refused) return
    const { intervalText: _typed, ...task } = editing
    setSaving(true)
    try {
      await api("/ping-tasks", { method: "POST", body: JSON.stringify({ ...task, interval: Number(intervalText) }) })
      toast.success("已保存，正在下发")
      setEditing(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/ping-tasks/${deleting.id}`, { method: "DELETE" })
      toast.success("监控已删除")
      setDeleting(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  const toggle = (id: number) =>
    setEditing((t) => {
      if (!t) return t
      const nodes = t.nodes ?? []
      return { ...t, nodes: nodes.includes(id) ? nodes.filter((n) => n !== id) : [...nodes, id] }
    })

  return (
    <div className="space-y-4">
      <div className="page-heading"><h1>监测</h1>
        <Button onClick={() => { setIntervalError(""); setEditing({ name: "", target: "", interval: 60, nodes: [] }) }}>
          添加监测
        </Button>
      </div>

      {tasks === null ? <LoadState error={error} retry={load} /> : <Card className="overflow-x-auto p-0">
        <Table className="monitoring-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">名称</TableHead>
              <TableHead className="w-[40%]">目标</TableHead>
              <TableHead className="w-[12%]">间隔</TableHead>
              <TableHead className="w-[12%]">节点</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="tnum text-sm">{t.target}</TableCell>
                <TableCell className="tnum text-sm">{t.interval}s</TableCell>
                <TableCell className="text-sm text-muted-foreground">{t.nodes.length} 个</TableCell>
                <TableCell><div className="monitoring-actions">
                  <Button variant="outline" onClick={() => { setIntervalError(""); setEditing(t) }} aria-label="编辑监测">编辑</Button>
                  <Button variant="ghost" onClick={() => setDeleting(t)} aria-label="删除监测">
                    删除
                  </Button></div>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm whitespace-normal text-muted-foreground">
                  还没有监测任务。添加目标地址并选择节点。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>}

      {editing && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{editing.id ? "编辑监测" : "添加监测"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="名称">
                  {/* A new romi node starts empty, so the cursor belongs here;
                      editing an existing one starts with nothing selected. */}
                  <Input autoFocus={!editing.id} value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Cloudflare" />
                </Field>
                <Field label="间隔（秒）" hint="5–3600" error={intervalError}>
                  {/* The typed text is kept as typed and checked by the rule the
                      approved prototype's numeric fields use: shown once the box
                      is left or the dialog submitted, then kept current while it
                      is corrected. */}
                  <Input
                    inputMode="numeric"
                    value={intervalText}
                    onChange={(e) => {
                      setEditing({ ...editing, intervalText: e.target.value })
                      if (intervalError) setIntervalError(checkInterval(e.target.value))
                    }}
                    onBlur={(e) => setIntervalError(checkInterval(e.target.value))}
                  />
                </Field>
              </div>
              <Field label="目标地址" hint="host:port">
                <Input value={editing.target ?? ""} onChange={(e) => setEditing({ ...editing, target: e.target.value })} placeholder="1.1.1.1:443" />
              </Field>
              <div className="space-y-2">
                <Label className="text-sm font-medium">执行节点</Label>
                <div className="choice-list">
                  {nodes.map((n) => (
                    <label key={n.id} className="choice-row">
                      <input type="checkbox" checked={editing.nodes?.includes(n.id) ?? false} onChange={() => toggle(n.id)} className="accent-primary" />
                      {n.name}
                    </label>
                  ))}
                  {nodes.length === 0 && <p className="p-2 text-xs text-muted-foreground">先添加节点</p>}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button onClick={save} disabled={saving}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除监测「${deleting.name}」？`}
          description="该监控及其历史延迟记录一并删除，不可恢复。"
          confirmLabel="删除监测"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}
