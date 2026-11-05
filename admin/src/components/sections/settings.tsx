import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import { T } from "../../../../shared/i18n.ts"
import { numericError } from "../../../../shared/validate.ts"
import { api } from "@/lib/api"
import { bytes } from "@/lib/format"
import { Button, Field, Input, Switch } from "../../../../web/src/components/ui/controls"
import { Notice } from "../../../../web/src/components/ui/feedback"
import { cx } from "../../../../web/src/lib/hooks"

import { PageLoad, SectionCard, useSettings, type Settings } from "./common"

type GeoStatus = { state: string; received: number; error: string; configured: boolean }
type View = "cards" | "list"

function ViewChoice({ value, onChange }: { value: View; onChange: (next: View) => void }) {
  const refs = useRef<Record<View, HTMLButtonElement | null>>({ cards: null, list: null })
  const options: [View, ReactNode][] = [["cards", T("卡片")], ["list", T("列表")]]
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = options.findIndex(([option]) => option === value)
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
        : 0
    if (!step) return
    event.preventDefault()
    const next = options[(at + step + options.length) % options.length][0]
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="view-choice" role="radiogroup" aria-label={T("公开页默认视图")} onKeyDown={move}>
      {options.map(([option, label]) => (
        <button
          key={option}
          ref={element => { refs.current[option] = element }}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          className="view-option"
          onClick={() => onChange(option)}
        >
          <span className={`view-art view-art-${option}`} aria-hidden="true">
            {Array.from({ length: option === "cards" ? 6 : 4 }, (_, index) => <i key={index}></i>)}
          </span>
          <span className="view-label"><span className="view-radio" aria-hidden="true"></span>{label}</span>
        </button>
      ))}
    </div>
  )
}

function GeoCard({ initialUrl, onUrlSaved }: { initialUrl: string; onUrlSaved: (url: string) => void }) {
  const [url, setUrl] = useState(initialUrl)
  const [status, setStatus] = useState<GeoStatus | null>(null)
  const [readError, setReadError] = useState("")
  const [updateError, setUpdateError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const next = await api<GeoStatus>("/geolite", { signal: controller.signal })
        if (controller.signal.aborted) return
        setStatus(next)
        setReadError("")
        timer = setTimeout(load, next.state === "downloading" ? 500 : 3000)
      } catch (e) {
        if (controller.signal.aborted) return
        setReadError((e as Error).message)
        timer = setTimeout(load, 3000)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  async function update() {
    setBusy(true)
    setUpdateError("")
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ geolite_url: url }) })
      onUrlSaved(url)
      await api("/geolite", { method: "POST" })
      setStatus(old => ({ ...(old ?? { state: "idle", received: 0, error: "", configured: false }), state: "downloading", received: 0, error: "" }))
    } catch (e) {
      setUpdateError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    setBusy(true)
    try {
      await api("/geolite", { method: "DELETE" })
      setStatus(old => old ? { ...old, state: "cancelled" } : old)
      setUpdateError("")
    } catch (e) {
      setUpdateError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const downloading = status?.state === "downloading"
  const failed = status?.state === "error" || !!updateError
  const urlError = url && !/^https:\/\/[^\s/@]+\/\S*$/.test(url) ? T("请填写不含账号信息的 HTTPS 地址") : ""
  const fieldError = updateError ? T(updateError) : urlError || (status?.state === "error" ? T(status.error) : "")
  return (
    <SectionCard
      id="geo"
      title="GeoLite2 Country"
      icon="globe"
      aside={<span className="tag" data-tone={status?.configured ? "ok" : undefined}>{status?.configured ? T("已配置本地数据库") : T("未配置")}</span>}
    >
      <p className="muted">{T("使用本地数据库查询节点国家/地区。")}</p>
      {readError && <Notice tone="bad">{T(readError)}</Notice>}
      <Field label={T("HTTPS 数据库直链")} error={fieldError}>
        <Input
          className="mono"
          value={url}
          placeholder="https://example.com/GeoLite2-Country.mmdb"
          onChange={event => { setUrl(event.target.value); setUpdateError("") }}
        />
      </Field>
      {downloading && (
        <div className="progress-block" role="status">
          <span className="progress"><i data-indeterminate></i></span>
          <span className="muted small num">{T("已下载 {size}", { size: bytes(status?.received ?? 0) })}</span>
        </div>
      )}
      <div className="inspector-actions">
        <span className="dirty-note">{status?.state === "complete" ? T("更新完成") : status?.state === "cancelled" ? T("已取消") : ""}</span>
        {downloading && <Button onClick={() => void cancel()} busy={busy}>{T("取消")}</Button>}
        <Button icon={failed ? "refresh-cw" : "download"} disabled={downloading || busy || !url.trim()} onClick={() => void update()}>
          {failed ? T("重试") : T("下载并更新")}
        </Button>
      </div>
    </SectionCard>
  )
}

type SettingsValues = {
  site_name: string
  public_page: boolean
  public_default_view: View
  retention_days: string
  online_grace_minutes: string
}

function initialValues(settings: Settings): SettingsValues {
  return {
    site_name: String(settings.site_name ?? ""),
    public_page: String(settings.public_page ?? "") === "on",
    public_default_view: String(settings.public_default_view ?? "cards") === "list" ? "list" : "cards",
    retention_days: String(settings.retention_days ?? "30"),
    online_grace_minutes: String(settings.online_grace_minutes ?? "5"),
  }
}

function SettingsContent({ settings, save, set, error }: {
  settings: Settings
  save: (patch: Record<string, string>, options?: { success?: string }) => Promise<Error | null>
  set: (key: string, value: string) => void
  error: string
}) {
  const [baseline, setBaseline] = useState(() => initialValues(settings))
  const [values, setValues] = useState(baseline)
  const [busy, setBusy] = useState(false)
  const dirty = (Object.keys(baseline) as (keyof SettingsValues)[]).some(key => baseline[key] !== values[key])
  const errors = {
    site_name: values.site_name.trim() ? "" : T("请填写站点名称"),
    retention_days: numericError(values.retention_days, { min: 1, max: 3650, required: true }),
    online_grace_minutes: numericError(values.online_grace_minutes, { min: 1, max: 60, required: true }),
  }
  const invalid = Object.values(errors).some(Boolean)
  const showErrors = dirty
  const setValue = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setValues(old => ({ ...old, [key]: value }))
  }

  async function saveSite() {
    if (invalid) return
    setBusy(true)
    const failure = await save({
      site_name: values.site_name,
      public_page: values.public_page ? "on" : "off",
      public_default_view: values.public_default_view,
      retention_days: values.retention_days,
      online_grace_minutes: values.online_grace_minutes,
    }, { success: T("站点设置已保存") })
    setBusy(false)
    if (!failure) setBaseline(values)
  }

  return (
    <div className="settings-layout">
      {error && <Notice tone="bad">{T(error)}</Notice>}
      <SectionCard id="site" title={T("站点")} icon="globe" className="card-wide">
        <div className="site-grid">
          <div className="inspector-form">
            <Field label={T("站点名称")} error={showErrors ? errors.site_name : ""}>
              <Input value={values.site_name} maxLength={64} onChange={event => setValue("site_name", event.target.value)} />
            </Field>
            <Switch
              checked={values.public_page}
              onChange={next => setValue("public_page", next)}
              label={T("开放公开状态页")}
              detail={T("关闭后所有页面需登录")}
            />
          </div>
          <div className="field">
            <span className="field-label">{T("公开页默认视图")}</span>
            <ViewChoice value={values.public_default_view} onChange={next => setValue("public_default_view", next)} />
            <p className="field-message"><span>{T("访客可临时切换，不影响这里的设置。")}</span></p>
          </div>
        </div>
      </SectionCard>
      <SectionCard id="history" title={T("历史与在线")} icon="history">
        <div className="inspector-form">
          <Field label={T("分钟历史保留天数")} hint={T("1–3650；小时历史保留一年")} error={showErrors ? errors.retention_days : ""}>
            <Input inputMode="numeric" value={values.retention_days} onChange={event => setValue("retention_days", event.target.value)} />
          </Field>
          <Field label={T("连续在线重置阈值（分钟）")} hint={T("1–60；中断超过此时长后重新计时")} error={showErrors ? errors.online_grace_minutes : ""}>
            <Input inputMode="numeric" value={values.online_grace_minutes} onChange={event => setValue("online_grace_minutes", event.target.value)} />
          </Field>
        </div>
      </SectionCard>
      <GeoCard initialUrl={String(settings.geolite_url ?? "")} onUrlSaved={url => set("geolite_url", url)} />
      <div className={cx("save-bar", dirty && "is-visible")} aria-hidden={!dirty}>
        <span>{T("有未保存的修改")}</span>
        <Button onClick={() => setValues(baseline)} tabIndex={dirty ? 0 : -1}>{T("放弃")}</Button>
        <Button kind="primary" busy={busy} disabled={invalid} onClick={() => void saveSite()} tabIndex={dirty ? 0 : -1}>
          {T("保存站点设置")}
        </Button>
      </div>
    </div>
  )
}

export function SettingsTab() {
  const { s, set, save, error, retry } = useSettings()
  const state = !s ? (error ? "error" : "loading") : "ready"
  return (
    <PageLoad state={state} label={T("设置")} onRetry={retry} detail={T(error)}>
      {s && <SettingsContent settings={s} save={save} set={set} error={error} />}
    </PageLoad>
  )
}
