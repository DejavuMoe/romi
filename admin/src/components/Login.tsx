import { useState } from "react"
import { T } from "../../../shared/i18n.ts"
import { Globe } from "../../../web/src/components/Globe"
import { LangButton, ThemeButton } from "../../../web/src/components/Shell"
import { Brand } from "../../../web/src/components/ui/brand"
import { Button, Field, Input, PasswordInput } from "../../../web/src/components/ui/controls"
import { Icon } from "../../../web/src/components/ui/icon"
import { type Theme } from "../../../web/src/lib/hooks"
import { api } from "@/lib/api"

export function Login({ onDone, siteName, theme, onTheme, publicOpen }: {
  onDone: () => void
  siteName: string
  theme: Theme
  onTheme: (event: { currentTarget: EventTarget | null }) => void
  publicOpen: boolean
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (!username.trim() || !password || busy) return
    setBusy(true)
    setError("")
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ username: username.trim(), password }) })
      onDone()
    } catch (err) {
      setError(T((err as Error).message))
    } finally { setBusy(false) }
  }
  return <div className="login" data-screen-id="login">
    <Globe variant="backdrop" theme={theme} />
    <div className="login-corner"><LangButton /><ThemeButton theme={theme} onToggle={onTheme} /></div>
    <form className="login-card" noValidate onSubmit={submit}>
      <div className="login-brand"><Brand name={siteName} size={28} /></div>
      <h1>{T("登录")}</h1>
      <Field label={T("账号")} error={submitted && !username.trim() ? T("请填写账号") : undefined}>
        <Input autoFocus value={username} autoComplete="username" onChange={e => { setUsername(e.target.value); setError("") }} />
      </Field>
      <Field label={T("密码")} error={submitted && !password ? T("请填写密码") : undefined}>
        <PasswordInput value={password} autoComplete="current-password" onChange={e => { setPassword(e.target.value); setError("") }} />
      </Field>
      <p className="login-error" role="alert">{error && <><Icon name="circle-alert" size={14} />{error}</>}</p>
      <Button kind="primary" type="submit" busy={busy} className="login-submit">{busy ? T("登录中…") : T("登录")}</Button>
      {publicOpen && <a className="login-back" href="/"><Icon name="arrow-left" size={14} />{T("返回公开状态页")}</a>}
    </form>
  </div>
}
