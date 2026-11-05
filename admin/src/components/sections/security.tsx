import { useEffect, useState, type FormEvent } from "react"

import { T } from "../../../../shared/i18n.ts"
import { api, ApiError } from "@/lib/api"
import { Button, Field, IconButton, Input, PasswordInput } from "../../../../web/src/components/ui/controls"
import { Empty, Notice, Skeleton, toast } from "../../../../web/src/components/ui/feedback"
import { Icon } from "../../../../web/src/components/ui/icon"
import { Confirm } from "../../../../web/src/components/ui/overlay"
import { full } from "../../../../web/src/lib/format"

import { PageLoad, SectionCard, useSettings } from "./common"

type Session = { id: string; current: boolean; created_at: number }
type SaveSettings = (patch: Record<string, string>, options?: { success?: string; quietStatus?: number }) => Promise<Error | null>

function Sessions({ revision }: { revision: number }) {
  const [rows, setRows] = useState<Session[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState("")
  const [revoking, setRevoking] = useState<Session | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    api<Session[]>("/sessions", { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) { setRows(next); setFailed(false) } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [revision, attempt])
  const retry = () => { setRows(null); setFailed(false); setAttempt(value => value + 1) }

  async function remove() {
    if (!revoking) return
    const target = revoking
    setBusy(target.id)
    try {
      await api(`/sessions/${target.id}`, { method: "DELETE" })
      toast(T("已删除会话"))
      setRevoking(null)
      setRows(old => old?.filter(session => session.id !== target.id) ?? null)
    } catch (e) {
      toast(T((e as Error).message), "bad")
    } finally {
      setBusy("")
    }
  }

  return (
    <SectionCard
      id="sessions"
      title={T("登录会话")}
      icon="monitor"
      aside={rows && <span className="muted small num">{T("{n} 个", { n: rows.length })}</span>}
    >
      {failed ? (
        <Empty
          error
          compact
          title={T("会话列表加载失败")}
          detail={T("暂时无法确认其他设备的登录状态。")}
          action={T("重试")}
          onAction={retry}
        />
      ) : !rows ? (
        <Skeleton style={{ height: 120 }} label={T("正在加载")} />
      ) : (
        <ul className="session-list">
          {rows.map(session => {
            const left = Math.ceil((session.created_at + 14 * 86400 - Date.now() / 1000) / 86400)
            return (
              <li key={session.id}>
                <span className="session-icon"><Icon name={session.current ? "laptop" : "monitor"} size={16} /></span>
                <span className="session-text">
                  <span className="num">{T("登录于 {time}", { time: full(session.created_at * 1000) })}</span>
                  <span className="muted small">{T("{n} 天后过期", { n: left })}</span>
                </span>
                {session.current
                  ? <span className="tag" data-tone="accent">{T("当前设备")}</span>
                  : <IconButton label={T("删除会话")} icon="trash-2" onClick={() => setRevoking(session)} tip="left" />}
              </li>
            )
          })}
        </ul>
      )}
      <p className="card-foot muted small">{T("每次登录一条，14 天后过期。删除后该设备下一次请求就被登出。")}</p>
      {revoking && (
        <Confirm
          title={T("删除会话？")}
          detail={T("登录于 {time} 的设备下一次请求就会被登出。", { time: full(revoking.created_at * 1000) })}
          confirmLabel={T("删除会话")}
          busy={busy === revoking.id}
          onClose={() => setRevoking(null)}
          onConfirm={remove}
        />
      )}
    </SectionCard>
  )
}

function SecurityContent({ settings, save, error, sessionRevision, onSettingsSaved }: {
  settings: Record<string, string | boolean>
  save: SaveSettings
  error: string
  sessionRevision: number
  onSettingsSaved: () => void
}) {
  const [account, setAccount] = useState(String(settings.admin_username ?? "admin"))
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [tried, setTried] = useState(false)
  const [currentError, setCurrentError] = useState("")
  const [busy, setBusy] = useState(false)
  const accountError = /^[A-Za-z0-9_.-]{1,64}$/.test(account) ? "" : T("1–64 位字母、数字、点、下划线或连字符")
  const nextError = next.length < 12 ? T("至少 12 位") : ""

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTried(true)
    if (!current) {
      setCurrentError(T("请填写当前密码"))
      requestAnimationFrame(() => document.getElementById("current-password")?.focus())
      return
    }
    if (accountError || nextError) return
    setBusy(true)
    const failure = await save(
      { admin_username: account, admin_password: next, current_password: current },
      { success: T("账号与密码已修改"), quietStatus: 403 },
    )
    setBusy(false)
    if (!failure) {
      setCurrent("")
      setNext("")
      setTried(false)
      setCurrentError("")
      onSettingsSaved()
      return
    }
    if (failure instanceof ApiError && failure.status === 403) {
      setCurrentError(T("当前密码不正确"))
      requestAnimationFrame(() => document.getElementById("current-password")?.focus())
    }
  }

  return (
    <div className="security-layout">
      {error && <Notice tone="bad">{T(error)}</Notice>}
      <SectionCard id="account" title={T("账号与密码")} icon="key-round">
        <form className="inspector-form" onSubmit={submit} noValidate>
          <Field label={T("账号")} error={tried ? accountError : ""}>
            <Input autoComplete="username" value={account} onChange={event => setAccount(event.target.value)} />
          </Field>
          <Field label={T("当前密码")} hint={T("修改账号或密码都需要先验证当前密码。")} error={currentError}>
            <PasswordInput
              id="current-password"
              autoComplete="current-password"
              value={current}
              onChange={event => { setCurrent(event.target.value); setCurrentError("") }}
            />
          </Field>
          <Field label={T("新密码")} hint={T("至少 12 位 · 已输入 {n} 位", { n: next.length })} error={tried ? nextError : ""}>
            <PasswordInput autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} />
          </Field>
          <div className="inspector-actions">
            <span className="dirty-note">{T("修改后，其他设备的登录会话失效")}</span>
            <Button kind="primary" type="submit" busy={busy}>{T("保存")}</Button>
          </div>
        </form>
      </SectionCard>
      <Sessions revision={sessionRevision} />
    </div>
  )
}

export function Security() {
  const { s, save, error, retry } = useSettings()
  const [sessions, setSessions] = useState(0)
  const state = !s ? (error ? "error" : "loading") : "ready"
  return (
    <PageLoad state={state} label={T("安全设置")} onRetry={retry} detail={T(error)}>
      {s && <SecurityContent settings={s} save={save} error={error} sessionRevision={sessions} onSettingsSaved={() => setSessions(value => value + 1)} />}
    </PageLoad>
  )
}
