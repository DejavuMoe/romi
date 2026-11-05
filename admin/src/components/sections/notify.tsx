import { useRef, useState, type ReactNode } from "react"

import { T } from "../../../../shared/i18n.ts"
import { connectionLabel } from "../../../../shared/nodes.ts"
import { numericError, validWebhookUrl } from "../../../../shared/validate.ts"
import { api, type Node } from "@/lib/api"
import { Mark } from "../../../../web/src/components/ui/brand"
import { Button, Field, Input, PasswordInput, Switch } from "../../../../web/src/components/ui/controls"
import { Notice, toast } from "../../../../web/src/components/ui/feedback"
import { Icon } from "../../../../web/src/components/ui/icon"

import { PageLoad, SectionCard, useSettings, type Settings } from "./common"

const PLACEHOLDERS = ["title", "message", "node", "event", "site", "time"] as const

function sampleNote() {
  const node = T("香港 · 甲商家")
  return {
    event: "offline",
    node,
    title: T("🔴 {node} 离线", { node }),
    message: T("最后上报 {time}", { time: "09-15 20:13 +08:00" }),
    time: "09-15 20:16 +08:00",
  }
}

function fillTemplate(template: string, site: string, json: boolean) {
  const values = { ...sampleNote(), site }
  return template.replace(/\{\{(event|node|title|message|site|time)\}\}/g, (_, key: keyof typeof values) =>
    json ? JSON.stringify(values[key]).slice(1, -1) : values[key],
  )
}

function TemplateEditor({ value, onChange, json, site, label, hint }: {
  value: string
  onChange: (next: string) => void
  json: boolean
  site: string
  label: string
  hint: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  let preview = ""
  let invalid = false
  if (value.trim()) {
    preview = fillTemplate(value, site, json)
    if (json) {
      try {
        preview = JSON.stringify(JSON.parse(preview), null, 2)
      } catch {
        invalid = true
      }
    }
  }
  const insert = (key: string) => {
    const element = ref.current
    const token = `{{${key}}}`
    const start = element ? element.selectionStart : value.length
    const end = element ? element.selectionEnd : value.length
    onChange(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  return (
    <div className="template">
      <Field
        label={label}
        hint={hint}
        error={invalid ? T('代入后不是合法 JSON，保存会被拒绝。占位符要写在引号里，例如 "text": "{{title}}"') : ""}
      >
        <textarea
          ref={ref}
          className="input textarea"
          rows={json ? 5 : 3}
          value={value}
          onChange={event => onChange(event.target.value)}
        />
      </Field>
      <div className="placeholder-row" aria-label={T("插入占位符")} role="group">
        {PLACEHOLDERS.map(key => (
          <button key={key} type="button" className="placeholder" onClick={() => insert(key)}>
            {`{{${key}}}`}
          </button>
        ))}
      </div>
      <div className="template-preview">
        <p className="field-label">{T("预览（以一条离线通知为例）")}</p>
        {!value.trim() ? (
          <p className="muted small">{T("留空保存即恢复默认模板")}</p>
        ) : json ? (
          <pre className={["json-preview", invalid && "is-invalid"].filter(Boolean).join(" ")}>
            {invalid ? fillTemplate(value, site, true) : preview}
          </pre>
        ) : (
          <div className="tg-preview">
            <span className="tg-avatar" aria-hidden="true"><Mark size={18} /></span>
            <div className="tg-bubble">
              <p className="tg-sender">{site}</p>
              <p className="tg-text">{preview}</p>
              <span className="tg-time num">20:16</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ChannelCard({ name, icon, configured, dirty, saving, testing, testReason, onSave, onTest, children }: {
  name: string
  icon: "send" | "webhook"
  configured: boolean
  dirty: boolean
  saving: boolean
  testing: boolean
  testReason: string
  onSave: () => void
  onTest: () => void
  children: ReactNode
}) {
  return (
    <SectionCard
      id={`ch-${name}`}
      title={name}
      icon={icon}
      className="channel"
      aside={(
        <span className="tag" data-tone={configured ? "ok" : undefined}>
          {configured ? <><Icon name="check" size={12} />{T("已配置")}</> : T("未配置")}
        </span>
      )}
    >
      <form className="inspector-form" onSubmit={event => { event.preventDefault(); onSave() }} noValidate>
        {children}
        <div className="inspector-actions">
          <span className="dirty-note">{dirty ? T("有未保存的修改") : testReason}</span>
          <Button icon="send" disabled={!configured || dirty || testing || saving} busy={testing} onClick={onTest}>
            {testing ? T("发送中…") : T("测试")}
          </Button>
          <Button kind="primary" type="submit" busy={saving} disabled={!dirty}>
            {T("保存")}
          </Button>
        </div>
      </form>
    </SectionCard>
  )
}

function OfflineNodes({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const [busy, setBusy] = useState(false)
  const enabled = nodes.filter(node => node.notify).length

  async function apply(targets: Node[], on: boolean, toastName?: string) {
    setBusy(true)
    try {
      await Promise.all(
        targets
          .filter(node => !!node.notify !== on)
          .map(node => api(`/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ notify: on }) })),
      )
      if (toastName) {
        toast(on
          ? T("已开启「{name}」离线通知", { name: toastName })
          : T("已关闭「{name}」离线通知", { name: toastName }))
      }
    } catch (e) {
      toast(T((e as Error).message), "bad")
    } finally {
      refresh()
      setBusy(false)
    }
  }

  return (
    <SectionCard
      id="offline-alerts"
      title={T("离线通知")}
      icon="wifi-off"
      aside={(
        <div className="offline-actions">
          <span className="muted small num">{enabled} / {nodes.length}</span>
          <Button size="sm" disabled={busy || nodes.every(node => !!node.notify)} onClick={() => void apply(nodes, true)}>{T("全部打开")}</Button>
          <Button size="sm" disabled={busy || nodes.every(node => !node.notify)} onClick={() => void apply(nodes, false)}>{T("全部关闭")}</Button>
        </div>
      )}
    >
      <div className="switch-list">
        {nodes.map(node => (
          <Switch
            key={node.id}
            checked={!!node.notify}
            onChange={next => void apply([node], next, node.name)}
            label={node.name}
            detail={connectionLabel(node)}
            disabled={busy}
          />
        ))}
      </div>
    </SectionCard>
  )
}

function NotifyContent({ settings, set, save, dirty, error, nodes, refresh }: {
  settings: Settings
  set: (key: string, value: string) => void
  save: (patch: Record<string, string>, options?: { success?: string }) => Promise<Error | null>
  dirty: (keys: string[]) => boolean
  error: string
  nodes: Node[]
  refresh: () => void
}) {
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const isBusy = (key: string) => busy.has(key)
  const markBusy = (key: string, active: boolean) => {
    setBusy(old => {
      const next = new Set(old)
      if (active) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const text = (key: string) => String(settings[key] ?? "")
  const site = text("site_name") || "Monitor"
  const tgSet = !!settings.notify_telegram_token_set
  const tgConfigured = tgSet && text("notify_telegram_chat") !== ""
  const whConfigured = !!settings.notify_webhook_url_set
  const token = text("notify_telegram_token")
  const chat = text("notify_telegram_chat")
  const url = text("notify_webhook_url")
  const tokenError = token && !/^\d+:[A-Za-z0-9_-]+$/.test(token) ? T("Bot Token 格式应为 123456:ABC-DEF") : ""
  const chatError = chat && !/^(-?\d+|@[A-Za-z0-9_]+)$/.test(chat) ? T("请填写数字 ID 或 @频道名") : ""
  const urlError = url && !validWebhookUrl(url) ? T("URL 须以 http:// 或 https:// 开头") : ""
  const ruleErrors = {
    grace: numericError(text("notify_grace"), { min: 1, max: 30, required: true }),
    traffic: numericError(text("notify_traffic"), { min: 0, max: 100, required: true }),
    expiry: numericError(text("notify_expiry"), { min: 0, max: 365, required: true }),
  }
  const tgDirty = dirty(["notify_telegram_token", "notify_telegram_chat", "notify_telegram_text"])
  const whDirty = dirty(["notify_webhook_url", "notify_webhook_headers", "notify_webhook_body"])
  const rulesDirty = dirty(["notify_grace", "notify_traffic", "notify_expiry", "notify_login"])

  async function saveChannel(key: string, patch: Record<string, string>, success: string) {
    markBusy(key, true)
    try {
      await save(patch, { success })
    } finally {
      markBusy(key, false)
    }
  }

  async function test(channel: "telegram" | "webhook") {
    markBusy(`test-${channel}`, true)
    try {
      const { sent } = await api<{ sent: string[] }>(`/notify/test?channel=${channel}`, { method: "POST" })
      toast(T("测试通知已发送：{label}", { label: sent.join("、") }))
    } catch (e) {
      toast(T((e as Error).message), "bad")
    } finally {
      markBusy(`test-${channel}`, false)
    }
  }

  const saveTelegram = () => {
    if (tokenError || chatError) return
    void saveChannel("tg", {
      notify_telegram_chat: chat,
      notify_telegram_text: text("notify_telegram_text"),
      ...(token ? { notify_telegram_token: token } : {}),
    }, T("Telegram 已保存"))
  }
  const saveWebhook = () => {
    if (urlError) return
    void saveChannel("wh", {
      notify_webhook_body: text("notify_webhook_body"),
      ...(url ? { notify_webhook_url: url } : {}),
      ...(text("notify_webhook_headers") ? { notify_webhook_headers: text("notify_webhook_headers") } : {}),
    }, T("Webhook 已保存"))
  }

  return (
    <div className="notify-layout">
      {error && <Notice tone="bad">{T(error)}</Notice>}
      <ChannelCard
        name="Telegram"
        icon="send"
        configured={tgConfigured}
        dirty={tgDirty}
        saving={isBusy("tg")}
        testing={isBusy("test-telegram")}
        testReason={tgConfigured ? T("使用已保存的配置测试") : T("先保存渠道配置")}
        onSave={saveTelegram}
        onTest={() => void test("telegram")}
      >
        <div className="form-grid">
          <Field label="Bot Token" hint={tgSet ? T("已设置，留空不变") : T("从 @BotFather 获取")} error={tokenError}>
            <PasswordInput
              autoComplete="off"
              value={token}
              placeholder={tgSet ? "••••••••" : "123456:ABC-DEF…"}
              onChange={event => set("notify_telegram_token", event.target.value)}
            />
          </Field>
          <Field label="Chat ID" hint={T("数字 ID，群组是负数；公开频道可填 @频道名")} error={chatError}>
            <Input className="mono" value={chat} placeholder="-1001234567890" onChange={event => set("notify_telegram_chat", event.target.value)} />
          </Field>
        </div>
        {tgSet && (
          <button type="button" className="link-button danger-link" onClick={() => void saveChannel("tg", { notify_telegram_token: "" }, T("已清除 Bot Token"))}>
            <Icon name="x" size={14} />{T("清除已保存的 Bot Token")}
          </button>
        )}
        <TemplateEditor label={T("消息模板")} hint={T("纯文本，可插入下方占位符")} value={text("notify_telegram_text")} onChange={value => set("notify_telegram_text", value)} site={site} json={false} />
      </ChannelCard>

      <ChannelCard
        name="Webhook"
        icon="webhook"
        configured={whConfigured}
        dirty={whDirty}
        saving={isBusy("wh")}
        testing={isBusy("test-webhook")}
        testReason={whConfigured ? T("使用已保存的配置测试") : T("先保存渠道配置")}
        onSave={saveWebhook}
        onTest={() => void test("webhook")}
      >
        <Field label="URL" hint={whConfigured ? T("已设置，留空不变") : T("以 POST 发送，Content-Type 为 application/json")} error={urlError}>
          <Input className="mono" value={url} placeholder={whConfigured ? "••••••••" : "https://…"} onChange={event => set("notify_webhook_url", event.target.value)} />
        </Field>
        <Field label={T("请求头")} hint={settings.notify_webhook_headers_set ? T("已设置，留空不变") : T("可选，一行一个")} optional>
          <textarea
            className="input textarea"
            rows={2}
            value={text("notify_webhook_headers")}
            placeholder={settings.notify_webhook_headers_set ? "••••••••" : "Authorization: Bearer xxx"}
            onChange={event => set("notify_webhook_headers", event.target.value)}
          />
        </Field>
        <TemplateEditor label={T("请求体")} hint={T("JSON，占位符须写在引号内")} value={text("notify_webhook_body")} onChange={value => set("notify_webhook_body", value)} site={site} json />
        {settings.notify_webhook_headers_set && (
          <button type="button" className="link-button danger-link" onClick={() => void saveChannel("wh", { notify_webhook_headers: "" }, T("已保存"))}>
            {T("清除请求头")}
          </button>
        )}
        {whConfigured && (
          <button type="button" className="link-button danger-link" onClick={() => void saveChannel("wh", { notify_webhook_url: "", notify_webhook_headers: "" }, T("已保存"))}>
            {T("清除 Webhook")}
          </button>
        )}
      </ChannelCard>

      <SectionCard id="rules" title={T("提醒规则")} icon="bell">
        <form
          className="inspector-form"
          noValidate
          onSubmit={event => {
            event.preventDefault()
            if (Object.values(ruleErrors).some(Boolean)) return
            void saveChannel("rules", {
              notify_grace: text("notify_grace"),
              notify_traffic: text("notify_traffic"),
              notify_expiry: text("notify_expiry"),
              notify_login: settings.notify_login === "off" ? "off" : "on",
            }, T("已保存"))
          }}
        >
          <Field label={T("离线宽限期（分钟）")} hint={T("断开超过这么久才算离线，1–30")} error={ruleErrors.grace}>
            <Input inputMode="numeric" value={text("notify_grace")} onChange={event => set("notify_grace", event.target.value)} />
          </Field>
          <Field label={T("流量提醒（%）")} hint={T("本期用量达到该比例和 100% 时各提醒一次，0 关闭")} error={ruleErrors.traffic}>
            <Input inputMode="numeric" value={text("notify_traffic")} onChange={event => set("notify_traffic", event.target.value)} />
          </Field>
          <Field label={T("到期提醒（天）")} hint={T("每天 9 点汇总这么多天内到期的节点，自动续期时也提醒，0 关闭")} error={ruleErrors.expiry}>
            <Input inputMode="numeric" value={text("notify_expiry")} onChange={event => set("notify_expiry", event.target.value)} />
          </Field>
          <Switch checked={settings.notify_login !== "off"} onChange={next => set("notify_login", next ? "on" : "off")} label={T("登录后台时提醒")} />
          <div className="inspector-actions">
            <span className="dirty-note">{rulesDirty ? T("有未保存的修改") : ""}</span>
            <Button kind="primary" type="submit" busy={isBusy("rules")} disabled={!rulesDirty}>{T("保存事件设置")}</Button>
          </div>
        </form>
      </SectionCard>

      <OfflineNodes nodes={nodes} refresh={refresh} />
    </div>
  )
}

export function Notify({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const { s, set, save, dirty, error, retry } = useSettings()
  const state = !s ? (error ? "error" : "loading") : "ready"
  return (
    <PageLoad state={state} label={T("通知设置")} onRetry={retry} detail={T(error)}>
      {s && <NotifyContent settings={s} set={set} save={save} dirty={dirty} error={error} nodes={nodes} refresh={refresh} />}
    </PageLoad>
  )
}
