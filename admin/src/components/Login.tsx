import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { api } from "@/lib/api"

// The hub redirects a failed GitHub sign-in back here with the reason attached,
// so it is readable in context rather than as a bare 401 page.
function callbackError(): string {
  const reason = new URLSearchParams(location.search).get("login_error")
  if (reason) history.replaceState({}, "", location.pathname)
  return reason ?? ""
}

export function Login({ github, onDone }: { github: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState(callbackError)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh place-items-center p-6">
      <Card className="w-full max-w-sm gap-5 p-6">
        <div className="flex items-baseline justify-between gap-4 border-b pb-4">
          <span className="text-xl font-semibold tracking-tight">romi</span>
          <h1 className="text-sm font-medium">登录后台</h1>
        </div>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        )}

        {github && (
          <>
            <Button asChild variant="outline" className="w-full">
              <a href="/api/auth/github">
                使用 GitHub 登录
              </a>
            </Button>
            <div className="relative">
              <Separator />
              <span className="absolute inset-0 -top-2 mx-auto w-fit bg-card px-2 text-xs text-muted-foreground">
                或使用应急密码
              </span>
            </div>
          </>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs">应急密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus={!github}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy || !password}>
            登录
          </Button>
        </form>
      </Card>
    </div>
  )
}
