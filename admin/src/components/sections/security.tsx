import { useEffect, useState } from "react"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { api, ApiError } from "@/lib/api"

import { LoadState, useSettings } from "./common"

type Session = { id: string; current: boolean; created_at: number }

function Sessions() {
  const [rows, setRows] = useState<Session[] | null>(null)
  const [busy, setBusy] = useState("")
  // The list fails on its own while the rest of the page works. The card used
  // to vanish with only a toast, which reads as "no other sessions" -- the one
  // thing a failed read cannot tell.
  const [failed, setFailed] = useState(false)

  const load = () =>
    api<Session[]>("/sessions")
      .then((next) => { setRows(next); setFailed(false) })
      .catch(() => { setRows(null); setFailed(true) })
  useEffect(() => { load() }, [])

  async function remove(id: string) {
    setBusy(id)
    try {
      await api(`/sessions/${id}`, { method: "DELETE" })
      toast.success("已删除会话")
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  if (!rows && !failed) return null
  return (
    <Card>
      <div>
        <h3 className="text-sm font-medium">登录会话</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          每次登录一条，14 天后过期。删除后该设备下一次请求就被登出。
        </p>
      </div>
      {!rows ? (
        <div role="alert" className="load-state">
          <span className="load-state-mark" aria-hidden="true">[ ! ]</span>
          <p className="load-state-title">会话列表加载失败</p>
          <p>暂时无法确认其他设备的登录状态。</p>
          <Button variant="outline" size="sm" onClick={load}>重试</Button>
        </div>
      ) : (
      <div className="divide-y">
        {rows.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span className="tnum">{new Date(s.created_at * 1000).toLocaleString()}</span>
              {s.current && <Badge variant="secondary">当前设备</Badge>}
            </div>
            {/* 当前会话没有删除按钮：右上角的退出登录做的就是这件事，而在这里删
                只会让已经渲染好的面板以为自己还登着。 */}
            {!s.current && (
              <Button size="icon" variant="ghost" title="删除会话" disabled={!!busy} onClick={() => remove(s.id)}>
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
      )}
    </Card>
  )
}

export function Security() {
  const { s, set, save, error, retry } = useSettings()
  const [password, setPassword] = useState("")
  const [current, setCurrent] = useState("")
  const [currentError, setCurrentError] = useState("")
  if (!s) return <LoadState error={error} retry={retry} />

  return (
    // The approved order: the account form, then the sessions it governs.
    <div className="space-y-4">{error && <p role="alert" className="field-error">{error}</p>}
      <Card>
        <div>
          <h3 className="text-sm font-medium">账号与密码</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            修改账号或密码后，其他设备的登录会话失效。
          </p>
        </div>
        <Field label="账号"><Input value={String(s.admin_username ?? "admin")} onChange={e=>set("admin_username",e.target.value)}/></Field>
        <Field label="当前密码" hint="修改账号或密码都需要先验证当前密码。" error={currentError}>
          <Input type="password" value={current} onChange={(e) => { setCurrent(e.target.value); setCurrentError("") }} autoComplete="current-password" />
        </Field>
        <Field label="新密码" hint="至少 12 位">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button
            size="sm"
            disabled={password.length < 12 || current === ""}
            onClick={() =>
              save({
                admin_username: String(s.admin_username ?? "admin"),
                admin_password: password,
                current_password: current,
              }).then((failure) => {
                // Cleared only once the hub accepted it. A rejected change that
                // empties the fields leaves the operator retyping a password the
                // panel never said it refused.
                if (!failure) {
                  setPassword("")
                  setCurrent("")
                  return
                }
                // A wrong password is the one refusal that belongs on a field.
                // Anything else is a failure of the request, which `save`
                // already reported.
                const refused = failure instanceof ApiError && failure.status === 403
                setCurrentError(refused ? "当前密码不正确" : "")
              })
            }
          >
            修改密码
          </Button>
        </div>
      </Card>

      <Sessions />
    </div>
  )
}
