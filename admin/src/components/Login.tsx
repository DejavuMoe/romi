import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"

// The hub redirects a failed GitHub sign-in back here with the reason attached,
// so it is readable in context rather than as a bare 401 page.
function callbackError(): string {
  const reason = new URLSearchParams(location.search).get("login_error")
  if (reason) history.replaceState({}, "", location.pathname)
  return reason ?? ""
}

// Where a GitHub sign-in should land. The OAuth round trip leaves the panel and
// the hub's callback returns to `/admin`, so the page the operator was trying
// to reach is kept here and resumed by `App` once the session exists.
export const RETURN_KEY = "romi-admin-return"

/** A stored return path, if it is still one of this panel's own pages. */
export function takeReturnPath(): string | null {
  const back = sessionStorage.getItem(RETURN_KEY)
  sessionStorage.removeItem(RETURN_KEY)
  // Only a path within the panel: the value round-trips through storage any
  // script on this origin can write, so it must not become a way to send the
  // operator anywhere else.
  return back && /^\/admin\/[\w/-]+$/.test(back) ? back : null
}

export function Login({ github, onDone }: { github: boolean; onDone: () => void }) {
  const [username, setUsername] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [password, setPassword] = useState("")
  const [error, setError] = useState(callbackError)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (!username.trim() || !password) return
    setBusy(true)
    setError("")
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ username: username.trim(), password }) })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="login-screen">
    <div className="login-content"><h1>登录</h1>
      <Card className="p-6"><form noValidate onSubmit={submit} className="space-y-4">
        <div className="login-field"><Label htmlFor="username">账号</Label><Input id="username" value={username} autoComplete="username" autoFocus onChange={e=>setUsername(e.target.value)} aria-invalid={submitted && !username.trim()} aria-describedby="username-error"/><p id="username-error" className="field-error">{submitted && !username.trim() ? "请填写账号" : ""}</p></div>
        <div className="login-field"><Label htmlFor="password">密码</Label><Input id="password" type="password" value={password} autoComplete="current-password" onChange={e=>setPassword(e.target.value)} aria-invalid={submitted && !password} aria-describedby="password-error"/><p id="password-error" className="field-error">{submitted && !password ? "请填写密码" : ""}</p></div>
        <p role="alert" className="field-error">{error}</p><Button type="submit" className="w-full" disabled={busy}>{busy ? "登录中…" : "登录"}</Button>
      </form></Card>
      {github && <Button asChild variant="outline" className="w-full"><a href="/api/auth/github" onClick={() => sessionStorage.setItem(RETURN_KEY, location.pathname)}>使用 GitHub 登录</a></Button>}
      <a className="text-center text-sm underline" href="/">返回公开状态页</a>
    </div>
  </div>
}
