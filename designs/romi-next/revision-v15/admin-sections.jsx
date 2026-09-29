// The panel's other sections: probes, notifications, data, security, settings.

const later = (fn, ms = 600) => setTimeout(fn, ms)

function Card({ title, icon, aside, children, className, id }) {
  return (
    <section className={cx("card", className)} aria-labelledby={id}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2 id={id} className="card-title">{icon && <Icon name={icon} size={16} />}{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

function PageLoad({ state, onRetry, label, children }) {
  if (state === "loading")
    return (
      <div className="stack-page" role="status" aria-label={T("正在加载")}>
        <div className="skeleton" style={{ height: 180 }}></div>
        <div className="skeleton" style={{ height: 260 }}></div>
      </div>
    )
  if (state === "error") return <Empty error title={T("{label}加载失败", { label })} detail={T("请求失败，未改变任何数据。")} action={T("重试")} onAction={onRetry} />
  return children
}

// ---- probes ----------------------------------------------------------------

function NodeChips({ ids, nodes, max = 4 }) {
  const list = ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean)
  return (
    <span className="node-chips">
      {list.slice(0, max).map((n) => (
        <span key={n.id} className="node-chip">
          <StatusDot status={fmt.connection(n)} />
          <span>{n.name}</span>
        </span>
      ))}
      {list.length > max && <span className="node-chip node-chip-more">+{list.length - max}</span>}
    </span>
  )
}

function ProbeDialog({ probe, nodes, onClose, onSave }) {
  const [v, setV] = useState({ name: probe?.name || "", target: probe?.target || "", interval: String(probe?.interval || 60), nodes: probe?.nodes || nodes.filter((n) => n.online).map((n) => n.id) })
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState("")
  const set = (k, x) => setV({ ...v, [k]: x })
  const targetOk = /^(\[[0-9a-fA-F:]+\]|[^\s:\[\]]+):(\d{1,5})$/.test(v.target) && Number(v.target.split(":").pop()) <= 65535
  const errors = {
    name: v.name.trim() ? "" : T("请填写名称"),
    target: !v.target.trim() ? T("请填写目标地址") : targetOk ? "" : T("请输入 host:port，例如 1.1.1.1:443"),
    interval: fmt.numericError(v.interval, { min: 5, max: 3600, required: true }),
  }
  const invalid = Object.values(errors).some(Boolean)
  const shown = nodes.filter((n) => n.name.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id) => set("nodes", v.nodes.includes(id) ? v.nodes.filter((x) => x !== id) : [...v.nodes, id])
  return (
    <Dialog
      title={probe ? T("编辑监测") : T("添加监测")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{T("取消")}</Button>
          <Button kind="primary" type="submit" form="probe-form" busy={busy}>{T("保存")}</Button>
        </>
      }
    >
      <form
        id="probe-form"
        className="inspector-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setTried(true)
          if (invalid) return
          setBusy(true)
          later(() => onSave({ ...probe, name: v.name.trim(), target: v.target.trim(), interval: Number(v.interval), nodes: v.nodes }))
        }}
      >
        <div className="form-grid">
          <Field label={T("名称")} error={tried && errors.name}><Input data-autofocus value={v.name} placeholder="Cloudflare" onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label={T("间隔（秒）")} hint="5–3600" error={errors.interval}><Input inputMode="numeric" value={v.interval} onChange={(e) => set("interval", e.target.value)} /></Field>
        </div>
        <Field label={T("目标地址")} hint="host:port" error={tried && errors.target}><Input className="mono" value={v.target} placeholder="1.1.1.1:443" onChange={(e) => set("target", e.target.value)} /></Field>
        <fieldset className="form-set">
          <legend>{T("执行节点")} <span className="muted num">{v.nodes.length} / {nodes.length}</span></legend>
          <div className="picker-tools">
            <label className="search-field">
              <Icon name="search" />
              <input type="search" aria-label={T("筛选节点")} placeholder={T("筛选节点")} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <button type="button" className="link-button" onClick={() => set("nodes", nodes.map((n) => n.id))}>{T("全选")}</button>
            <button type="button" className="link-button" onClick={() => set("nodes", nodes.filter((n) => n.online).map((n) => n.id))}>{T("仅在线")}</button>
            <button type="button" className="link-button" onClick={() => set("nodes", [])}>{T("清空")}</button>
          </div>
          <div className="picker-list">
            {shown.map((n) => (
              <Check key={n.id} checked={v.nodes.includes(n.id)} onChange={() => toggle(n.id)} detail={[window.romiGeo.countryName(n.country), fmt.connectionLabel(n)].filter(Boolean).join(" · ")}>
                {n.name}
              </Check>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}

function ProbesPage({ probes, setProbes, nodes, state, onRetry }) {
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [busy, setBusy] = useState(false)
  return (
    <PageLoad state={state} onRetry={onRetry} label={T("监测")}>
      <div className="stack-page">
        <div className="toolbar">
          <p className="toolbar-text num">{T("{n} 个监测任务", { n: probes.length })}</p>
          <div className="toolbar-end">
            <Button kind="primary" icon="plus" onClick={() => setEditing({})}>{T("添加监测")}</Button>
          </div>
        </div>
        {!probes.length ? (
          <Empty icon="radar" title={T("还没有监测任务")} detail={T("添加目标地址并选择节点。")} action={T("添加监测")} onAction={() => setEditing({})} />
        ) : (
          <div className="probe-grid">
            {probes.map((p) => (
              <article key={p.id} className="probe-card">
                <div className="probe-head">
                  <span className="probe-icon"><Icon name="radar" size={20} /></span>
                  <div className="probe-title">
                    <h3>{p.name}</h3>
                    <p className="mono">{p.target}</p>
                  </div>
                  <div className="probe-actions">
                    <IconButton label={T("编辑 {name}", { name: p.name })} icon="pencil" onClick={() => setEditing(p)} tip="top" />
                    <IconButton label={T("删除 {name}", { name: p.name })} icon="trash-2" onClick={() => setDeleting(p)} tip="top" />
                  </div>
                </div>
                <dl className="probe-facts">
                  <div><dt>{T("间隔")}</dt><dd className="num">{T("{n} 秒", { n: p.interval })}</dd></div>
                  <div><dt>{T("执行节点")}</dt><dd className="num">{T("{n} 个", { n: p.nodes.length })}</dd></div>
                </dl>
                <NodeChips ids={p.nodes} nodes={nodes} />
              </article>
            ))}
          </div>
        )}
        {editing && (
          <ProbeDialog
            probe={editing.id ? editing : null}
            nodes={nodes}
            onClose={() => setEditing(null)}
            onSave={(p) => {
              setProbes(p.id ? probes.map((x) => (x.id === p.id ? p : x)) : [...probes, { ...p, id: Math.max(0, ...probes.map((x) => x.id)) + 1 }])
              setEditing(null)
              toast(T("已保存，正在下发"))
            }}
          />
        )}
        {deleting && (
          <Confirm
            title={T("删除监测「{name}」？", { name: deleting.name })}
            detail={T("该监控及其历史延迟记录一并删除，不可恢复。")}
            confirmLabel={T("删除监测")}
            busy={busy}
            onClose={() => setDeleting(null)}
            onConfirm={() => {
              setBusy(true)
              later(() => {
                setProbes(probes.filter((x) => x.id !== deleting.id))
                setDeleting(null)
                setBusy(false)
                toast(T("监控已删除"))
              })
            }}
          />
        )}
      </div>
    </PageLoad>
  )
}

// ---- notifications ------------------------------------------------------------

const sampleNote = () => {
  const node = T("香港 · 甲商家")
  return { event: "offline", node, title: T("🔴 {node} 离线", { node }), message: T("最后上报 {time}", { time: "09-15 20:13 +08:00" }), time: "09-15 20:16 +08:00" }
}
const PLACEHOLDERS = ["title", "message", "node", "event", "site", "time"]
function fillTemplate(template, site, json) {
  const values = { ...sampleNote(), site }
  return template.replace(/\{\{(event|node|title|message|site|time)\}\}/g, (_, k) => (json ? JSON.stringify(values[k]).slice(1, -1) : values[k]))
}

function TemplateEditor({ value, onChange, json, site, label, hint }) {
  const ref = useRef(null)
  const insert = (key) => {
    const el = ref.current
    const token = `{{${key}}}`
    const at = el ? el.selectionStart : value.length
    const end = el ? el.selectionEnd : value.length
    onChange(value.slice(0, at) + token + value.slice(end))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + token.length, at + token.length) })
  }
  let preview = null, invalid = false
  if (value.trim()) {
    preview = fillTemplate(value, site, json)
    if (json) {
      try { preview = JSON.stringify(JSON.parse(preview), null, 2) } catch (_) { invalid = true }
    }
  }
  return (
    <div className="template">
      <Field label={label} hint={hint} error={invalid ? T("代入后不是合法 JSON，保存会被拒绝。占位符要写在引号里，例如 \"text\": \"{{title}}\"") : ""}>
        <textarea ref={ref} className="input textarea" rows={json ? 5 : 3} value={value} onChange={(e) => onChange(e.target.value)}></textarea>
      </Field>
      <div className="placeholder-row" aria-label={T("插入占位符")} role="group">
        {PLACEHOLDERS.map((k) => (
          <button key={k} type="button" className="placeholder" onClick={() => insert(k)}>{`{{${k}}}`}</button>
        ))}
      </div>
      <div className="template-preview">
        <p className="field-label">{T("预览（以一条离线通知为例）")}</p>
        {!value.trim() ? (
          <p className="muted small">{T("留空保存即恢复默认模板")}</p>
        ) : json ? (
          <pre className={cx("json-preview", invalid && "is-invalid")}>{invalid ? fillTemplate(value, site, true) : preview}</pre>
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

function ChannelCard({ name, icon, configured, children, dirty, onSave, onTest, testing, saving, testReason }) {
  return (
    <Card
      id={`ch-${name}`}
      title={name}
      icon={icon}
      className="channel"
      aside={<span className="tag" data-tone={configured ? "ok" : undefined}>{configured ? <><Icon name="check" size={12} />{T("已配置")}</> : T("未配置")}</span>}
    >
      <form className="inspector-form" onSubmit={(e) => { e.preventDefault(); onSave() }} noValidate>
        {children}
        <div className="inspector-actions">
          <span className="dirty-note">{dirty ? T("有未保存的修改") : testReason}</span>
          <Button icon="send" disabled={!configured || dirty || testing} busy={testing} onClick={onTest}>{testing ? T("发送中…") : T("测试")}</Button>
          <Button kind="primary" type="submit" busy={saving} disabled={!dirty}>{T("保存")}</Button>
        </div>
      </form>
    </Card>
  )
}

function NotifyPage({ settings, setSettings, nodes, state, onRetry }) {
  const site = settings.site_name || "Monitor"
  const tgInit = { token: "", chat: settings.notify_telegram_chat, text: settings.notify_telegram_text }
  const whInit = { url: "", headers: "", body: settings.notify_webhook_body }
  const ruleInit = { grace: settings.notify_grace, traffic: settings.notify_traffic, expiry: settings.notify_expiry, login: settings.notify_login === "on" }
  const tg = useForm(tgInit), wh = useForm(whInit), rules = useForm(ruleInit)
  const [busy, setBusy] = useState("")
  const [cleared, setCleared] = useState(false)
  const tgSet = settings.notify_telegram_token_set && !cleared
  const tgConfigured = tgSet && !!settings.notify_telegram_chat
  const whConfigured = settings.notify_webhook_url_set
  const tokenError = tg.values.token && !/^\d+:[A-Za-z0-9_-]+$/.test(tg.values.token) ? T("Bot Token 格式应为 123456:ABC-DEF") : ""
  const chatError = tg.values.chat && !/^(-?\d+|@[A-Za-z0-9_]+)$/.test(tg.values.chat) ? T("请填写数字 ID 或 @频道名") : ""
  const urlError = wh.values.url && !/^https?:\/\/\S+$/.test(wh.values.url) ? T("URL 须以 http:// 或 https:// 开头") : ""
  const ruleErrors = {
    grace: fmt.numericError(rules.values.grace, { min: 1, max: 30, required: true }),
    traffic: fmt.numericError(rules.values.traffic, { min: 0, max: 100, required: true }),
    expiry: fmt.numericError(rules.values.expiry, { min: 0, max: 365, required: true }),
  }
  const save = (key, form, patch, text) => {
    setBusy(key)
    later(() => {
      setSettings({ ...settings, ...patch })
      form.setValues({ ...form.values, ...(key === "tg" ? { token: "" } : key === "wh" ? { url: "", headers: "" } : {}) })
      setBusy("")
      toast(text)
    })
  }
  const test = (key, label) => {
    setBusy(`test-${key}`)
    later(() => { setBusy(""); toast(T("测试通知已发送：{label}", { label })) }, 900)
  }
  return (
    <PageLoad state={state} onRetry={onRetry} label={T("通知设置")}>
      <div className="notify-layout">
        <ChannelCard
          name="Telegram"
          icon="send"
          configured={tgConfigured}
          dirty={tg.dirty}
          saving={busy === "tg"}
          testing={busy === "test-tg"}
          testReason={tgConfigured ? T("使用已保存的配置测试") : T("先保存渠道配置")}
          onTest={() => test("tg", "Telegram")}
          onSave={() => !tokenError && !chatError && save("tg", tg, { notify_telegram_token_set: tgSet || !!tg.values.token, notify_telegram_chat: tg.values.chat, notify_telegram_text: tg.values.text }, T("Telegram 已保存"))}
        >
          <div className="form-grid">
            <Field label="Bot Token" hint={tgSet ? T("已设置，留空不变") : T("从 @BotFather 获取")} error={tokenError}>
              <PasswordInput autoComplete="off" value={tg.values.token} placeholder={tgSet ? "••••••••" : "123456:ABC-DEF…"} onChange={(e) => tg.set("token", e.target.value)} />
            </Field>
            <Field label="Chat ID" hint={T("数字 ID，群组是负数；公开频道可填 @频道名")} error={chatError}>
              <Input className="mono" value={tg.values.chat} placeholder="-1001234567890" onChange={(e) => tg.set("chat", e.target.value)} />
            </Field>
          </div>
          {tgSet && (
            <button type="button" className="link-button danger-link" onClick={() => { setCleared(true); setSettings({ ...settings, notify_telegram_token_set: false }); toast(T("已清除 Bot Token")) }}>
              <Icon name="x" size={14} />{T("清除已保存的 Bot Token")}
            </button>
          )}
          <TemplateEditor label={T("消息模板")} hint={T("纯文本，可插入下方占位符")} value={tg.values.text} onChange={(x) => tg.set("text", x)} site={site} />
        </ChannelCard>
        <ChannelCard
          name="Webhook"
          icon="webhook"
          configured={whConfigured}
          dirty={wh.dirty}
          saving={busy === "wh"}
          testing={busy === "test-wh"}
          testReason={whConfigured ? T("使用已保存的配置测试") : T("先保存渠道配置")}
          onTest={() => test("wh", "Webhook")}
          onSave={() => !urlError && save("wh", wh, { notify_webhook_url_set: whConfigured || !!wh.values.url, notify_webhook_body: wh.values.body }, T("Webhook 已保存"))}
        >
          <Field label="URL" hint={whConfigured ? T("已设置，留空不变") : T("以 POST 发送，Content-Type 为 application/json")} error={urlError}>
            <Input className="mono" value={wh.values.url} placeholder={whConfigured ? "••••••••" : "https://…"} onChange={(e) => wh.set("url", e.target.value)} />
          </Field>
          <Field label={T("请求头")} hint={T("可选，一行一个")} optional>
            <Textarea rows={2} value={wh.values.headers} placeholder="Authorization: Bearer xxx" onChange={(e) => wh.set("headers", e.target.value)} />
          </Field>
          <TemplateEditor label={T("请求体")} hint={T("JSON，占位符须写在引号内")} value={wh.values.body} onChange={(x) => wh.set("body", x)} site={site} json />
        </ChannelCard>
        <Card id="rules" title={T("提醒规则")} icon="bell">
          <form
            className="inspector-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              if (Object.values(ruleErrors).some(Boolean)) return
              save("rules", rules, { notify_grace: rules.values.grace, notify_traffic: rules.values.traffic, notify_expiry: rules.values.expiry, notify_login: rules.values.login ? "on" : "off" }, T("已保存"))
            }}
          >
            <Field label={T("离线宽限期（分钟）")} hint={T("断开超过这么久才算离线，1–30")} error={ruleErrors.grace}>
              <Input inputMode="numeric" value={rules.values.grace} onChange={(e) => rules.set("grace", e.target.value)} />
            </Field>
            <Field label={T("流量提醒（%）")} hint={T("本期用量达到该比例和 100% 时各提醒一次，0 关闭")} error={ruleErrors.traffic}>
              <Input inputMode="numeric" value={rules.values.traffic} onChange={(e) => rules.set("traffic", e.target.value)} />
            </Field>
            <Field label={T("到期提醒（天）")} hint={T("每天 9 点汇总这么多天内到期的节点，自动续期时也提醒，0 关闭")} error={ruleErrors.expiry}>
              <Input inputMode="numeric" value={rules.values.expiry} onChange={(e) => rules.set("expiry", e.target.value)} />
            </Field>
            <Switch checked={rules.values.login} onChange={(x) => rules.set("login", x)} label={T("登录后台时提醒")} />
            <div className="inspector-actions">
              <span className="dirty-note">{rules.dirty ? T("有未保存的修改") : ""}</span>
              <Button kind="primary" type="submit" busy={busy === "rules"} disabled={!rules.dirty}>{T("保存事件设置")}</Button>
            </div>
          </form>
        </Card>
        <Card id="offline-alerts" title={T("离线通知")} icon="wifi-off" aside={<span className="muted small num">{nodes.filter((n) => n.notify).length} / {nodes.length}</span>}>
          <div className="switch-list">
            {nodes.map((n) => (
              <Switch
                key={n.id}
                checked={!!n.notify}
                onChange={(x) => { window.romiSim.update(n.id, { notify: x }); toast(x ? T("已开启「{name}」离线通知", { name: n.name }) : T("已关闭「{name}」离线通知", { name: n.name })) }}
                label={n.name}
                detail={fmt.connectionLabel(n)}
              />
            ))}
          </div>
        </Card>
      </div>
    </PageLoad>
  )
}

// ---- data ---------------------------------------------------------------------

function RestoreDialog({ file, onClose, onDone }) {
  const [phase, setPhase] = useState("confirm")
  const [sent, setSent] = useState(0)
  const [kept, setKept] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearInterval(timer.current), [])
  const start = () => {
    setPhase("upload")
    timer.current = setInterval(() => {
      setSent((s) => {
        const next = Math.min(file.size, s + 4 * 1024 * 1024)
        if (next >= file.size) {
          clearInterval(timer.current)
          setPhase("verify")
          later(() => onDone(), 1200)
        }
        return next
      })
    }, 260)
  }
  const cancel = () => {
    clearInterval(timer.current)
    onClose(phase === "upload" ? T("已取消恢复") : "")
  }
  const pct = (sent / file.size) * 100
  return (
    <Dialog
      title={T("用备份覆盖当前数据？")}
      onClose={cancel}
      size="sm"
      footer={
        <>
          <Button onClick={cancel} disabled={phase === "verify"}>{T("取消")}</Button>
          <Button kind="danger" onClick={start} busy={phase !== "confirm"} disabled={!kept}>
            {phase === "confirm" ? T("确认恢复") : phase === "upload" ? T("已上传 {sent} / {size}", { sent: fmt.bytes(sent), size: fmt.bytes(file.size) }) : T("正在校验并切换")}
          </Button>
        </>
      }
    >
      <p className="confirm-detail">{T("将用")} <b className="mono">{file.name}</b>{T("（{size}）整体替换当前数据库。当前的节点、设置和历史全部丢失，且无法撤销。恢复后所有登录会话结束。", { size: fmt.bytes(file.size) })}</p>
      <Check checked={kept} onChange={setKept} disabled={phase !== "confirm"}>{T("我已保留当前数据的备份")}</Check>
      {phase !== "confirm" && (
        <div className="progress-block" role="status">
          <span className="progress"><i style={{ width: `${phase === "verify" ? 100 : pct}%` }} data-verify={phase === "verify" || undefined}></i></span>
          <span className="muted small num">{phase === "upload" ? T("上传中 {pct}%", { pct: pct.toFixed(0) }) : T("校验归档与关系，完成后替换数据库")}</span>
        </div>
      )}
    </Dialog>
  )
}

function DataPage({ settings, setSettings, state, onRetry, onRestored }) {
  const db = window.romiFixtures.db
  const [maint, setMaint] = useState(settings.maintenance_days)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState("")
  const [file, setFile] = useState(null)
  const [drag, setDrag] = useState(false)
  const picker = useRef(null)
  const choose = (f) => {
    if (!f) return
    if (!/\.(tar\.gz|tgz|gz)$/i.test(f.name)) return toast(T("请选择 .tar.gz 备份文件"), "bad")
    setFile({ name: f.name, size: f.size || 38 * 1024 * 1024 })
  }
  const used = db.size - db.free
  const q = db.queue
  return (
    <PageLoad state={state} onRetry={onRetry} label={T("数据统计")}>
      <div className="data-layout">
        <Card id="db" title={T("数据库")} icon="database" className="db-card" aside={<span className="muted small">{db.engine} · schema {db.schema}</span>}>
          <div className="db-hero">
            <div>
              <p className="db-size num">{fmt.bytesParts(db.size).value}<span className="unit">{fmt.bytesParts(db.size).unit}</span></p>
              <p className="muted small mono">{db.path}</p>
            </div>
            <div className="db-bar" aria-hidden="true">
              <i style={{ flex: used }} className="db-used"></i>
              <i style={{ flex: db.free }} className="db-free"></i>
              <i style={{ flex: db.wal }} className="db-wal"></i>
            </div>
            <div className="db-legend">
              <span><i className="db-used"></i>{T("已用 {size}", { size: fmt.bytes(used) })}</span>
              <span><i className="db-free"></i>{T("可复用空间 {size}", { size: fmt.bytes(db.free) })}</span>
              <span><i className="db-wal"></i>{T("预写日志 {size}", { size: fmt.bytes(db.wal) })}</span>
            </div>
          </div>
          <dl className="stat-grid">
            <div><dt>{T("历史明细")}</dt><dd className="num">{db.rows.metric.toLocaleString()}</dd></div>
            <div><dt>{T("延迟记录")}</dt><dd className="num">{db.rows.ping_record.toLocaleString()}</dd></div>
            <div><dt>{T("最早记录")}</dt><dd className="num">{fmt.full(db.oldest * 1000).slice(0, 10)}</dd></div>
            <div><dt>{T("分钟历史保留")}</dt><dd className="num">{T("{n} 天", { n: settings.retention_days })}</dd></div>
          </dl>
        </Card>
        <Card id="backup" title={T("备份与恢复")} icon="file-archive">
          <div className="backup-row">
            <p className="muted">{T("备份包含凭据摘要，请勿公开。仅导入此处导出的备份文件。")}</p>
            <Button icon="download" busy={busy === "backup"} onClick={() => { setBusy("backup"); later(() => { setBusy(""); toast(T("备份已开始下载")) }, 900) }}>
              {busy === "backup" ? T("正在准备…") : T("下载备份")}
            </Button>
          </div>
          <button
            type="button"
            className={cx("dropzone", drag && "is-over")}
            onClick={() => picker.current.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); choose(e.dataTransfer.files[0]) }}
          >
            <Icon name="upload" size={24} />
            <span className="dropzone-title">{T("拖入备份文件，或点击选择")}</span>
            <span className="muted small">{T(".tar.gz · 验证通过前不会替换当前数据库")}</span>
          </button>
          <input ref={picker} type="file" accept=".gz,.tgz" hidden onChange={(e) => { choose(e.target.files[0]); e.target.value = "" }} />
        </Card>
        <Card id="queue" title={T("写入队列")} icon="activity">
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
        </Card>
        <Card id="maintenance" title={T("维护")} icon="wrench">
          <p className="muted">{T("清理过期历史明细，累计流量保持不变。请预留至少与数据库等量的空闲磁盘。")}</p>
          <div className="maint-row">
            <Field label={T("自动维护周期")}>
              <Select value={maint} onChange={(e) => setMaint(e.target.value)}>
                <option value="0">{T("关闭#off")}</option>
                {["7", "30", "90", "180"].map((d) => <option key={d} value={d}>{T("每 {n} 天", { n: d })}</option>)}
              </Select>
            </Field>
            <Button disabled={maint === settings.maintenance_days} busy={busy === "maint-save"} onClick={() => { setBusy("maint-save"); later(() => { setSettings({ ...settings, maintenance_days: maint }); setBusy(""); toast(T("已保存")) }) }}>{T("保存周期")}</Button>
          </div>
          <p className="muted small">{settings.maintenance_days === "0" ? T("自动维护已关闭") : T("已启用 · 每 {maintenance_days} 天，每小时检查一次是否到期", { maintenance_days: settings.maintenance_days })}</p>
          <div className="divider"></div>
          <div className="maint-row">
            <div>
              <p className="danger-title">{T("立即维护")}</p>
              <p className="muted small">{T("维护期间写入可能短暂等待。")}</p>
            </div>
            <Button icon="wrench" busy={busy === "maint"} onClick={() => setConfirm(true)}>{T("运行维护")}</Button>
          </div>
        </Card>
        {confirm && (
          <Confirm
            title={T("运行数据库维护？")}
            detail={T("将删除超出保留期的历史明细。累计流量不受影响，维护期间写入可能短暂等待。")}
            confirmLabel={T("运行维护")}
            danger={false}
            busy={busy === "maint"}
            onClose={() => setConfirm(false)}
            onConfirm={() => { setBusy("maint"); later(() => { setBusy(""); setConfirm(false); toast(T("已清理 1,284 行，可复用 18.4 MiB 未达重写阈值，本次未重写文件")) }, 1400) }}
          />
        )}
        {file && (
          <RestoreDialog
            file={file}
            onClose={(msg) => { setFile(null); if (msg) toast(msg, "info") }}
            onDone={() => { setFile(null); onRestored() }}
          />
        )}
      </div>
    </PageLoad>
  )
}

// ---- security -------------------------------------------------------------------

function SecurityPage({ settings, setSettings, state, onRetry }) {
  const [account, setAccount] = useState(settings.admin_username)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [tried, setTried] = useState(false)
  const [currentError, setCurrentError] = useState("")
  const [busy, setBusy] = useState("")
  const [sessions, setSessions] = useState(window.romiFixtures.sessions)
  const [sessionsFailed, setSessionsFailed] = useState(scenario === "sessions-error")
  const [revoking, setRevoking] = useState(null)
  const accountError = !/^[A-Za-z0-9_.-]{1,64}$/.test(account) ? T("1–64 位字母、数字、点、下划线或连字符") : ""
  const nextError = next.length < 12 ? T("至少 12 位") : ""
  const submit = (e) => {
    e.preventDefault()
    setTried(true)
    if (!current) return setCurrentError(T("请填写当前密码"))
    if (accountError || nextError) return
    setBusy("save")
    later(() => {
      setBusy("")
      if (current !== "romi-prototype") {
        setCurrentError(T("当前密码不正确"))
        document.getElementById("current-password")?.focus()
        return
      }
      // The hub keeps this session and drops every other one.
      setSettings({ ...settings, admin_username: account })
      setSessions(sessions.filter((x) => x.current))
      setCurrent("")
      setNext("")
      setTried(false)
      toast(T("账号与密码已修改"))
    }, 700)
  }
  return (
    <PageLoad state={state} onRetry={onRetry} label={T("安全设置")}>
      <div className="security-layout">
        <Card id="account" title={T("账号与密码")} icon="key-round">
          <form className="inspector-form" onSubmit={submit} noValidate>
            <Field label={T("账号")} error={tried && accountError}>
              <Input autoComplete="username" value={account} onChange={(e) => setAccount(e.target.value)} />
            </Field>
            <Field label={T("当前密码")} hint={T("修改账号或密码都需要先验证当前密码。")} error={currentError}>
              <PasswordInput id="current-password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setCurrentError("") }} />
            </Field>
            <Field label={T("新密码")} hint={T("至少 12 位 · 已输入 {n} 位", { n: next.length })} error={tried && nextError}>
              <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <div className="inspector-actions">
              <span className="dirty-note">{T("修改后，其他设备的登录会话失效")}</span>
              <Button kind="primary" type="submit" busy={busy === "save"}>{T("保存")}</Button>
            </div>
          </form>
        </Card>
        <Card id="sessions" title={T("登录会话")} icon="monitor" aside={!sessionsFailed && <span className="muted small num">{T("{n} 个", { n: sessions.length })}</span>}>
          {sessionsFailed ? (
            <Empty error compact title={T("会话列表加载失败")} detail={T("暂时无法确认其他设备的登录状态。")} action={T("重试")} onAction={() => { setSessionsFailed(false); toast(T("会话列表已更新")) }} />
          ) : (
            <ul className="session-list">
              {sessions.map((s) => {
                const left = Math.ceil((s.created_at + 14 * 86400 - Date.now() / 1000) / 86400)
                return (
                  <li key={s.id}>
                    <span className="session-icon"><Icon name={s.current ? "laptop" : "monitor"} size={16} /></span>
                    <span className="session-text">
                      <span className="num">{T("登录于 {time}", { time: fmt.full(s.created_at * 1000) })}</span>
                      <span className="muted small">{T("{n} 天后过期", { n: left })}</span>
                    </span>
                    {s.current ? <span className="tag" data-tone="accent">{T("当前设备")}</span> : <IconButton label={T("删除会话")} icon="trash-2" onClick={() => setRevoking(s)} tip="left" />}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="card-foot muted small">{T("每次登录一条，14 天后过期。删除后该设备下一次请求就被登出。")}</p>
        </Card>
        {revoking && (
          <Confirm
            title={T("删除会话？")}
            detail={T("登录于 {time} 的设备下一次请求就会被登出。", { time: fmt.full(revoking.created_at * 1000) })}
            confirmLabel={T("删除会话")}
            busy={busy === "revoke"}
            onClose={() => setRevoking(null)}
            onConfirm={() => { setBusy("revoke"); later(() => { setSessions(sessions.filter((x) => x.id !== revoking.id)); setRevoking(null); setBusy(""); toast(T("已删除会话")) }) }}
          />
        )}
      </div>
    </PageLoad>
  )
}

// ---- settings --------------------------------------------------------------------

function ViewChoice({ value, onChange }) {
  return (
    <div className="view-choice" role="radiogroup" aria-label={T("公开页默认视图")}>
      {[["cards", T("卡片")], ["list", T("列表")]].map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className="view-option" onClick={() => onChange(v)}>
          <span className={`view-art view-art-${v}`} aria-hidden="true">
            {v === "cards" ? Array.from({ length: 6 }, (_, i) => <i key={i}></i>) : Array.from({ length: 4 }, (_, i) => <i key={i}></i>)}
          </span>
          <span className="view-label"><span className="view-radio"></span>{label}</span>
        </button>
      ))}
    </div>
  )
}

function GeoCard({ settings, setSettings }) {
  const [url, setUrl] = useState(settings.geolite_url)
  const [status, setStatus] = useState(window.romiFixtures.geolite)
  const timer = useRef(null)
  useEffect(() => () => clearInterval(timer.current), [])
  const valid = /^https:\/\/[^\s/@]+\/\S*$/.test(url)
  const start = () => {
    setSettings({ ...settings, geolite_url: url })
    setStatus({ ...status, state: "downloading", received: 0, error: "" })
    const total = 9.3 * 1024 * 1024
    timer.current = setInterval(() => {
      setStatus((s) => {
        const received = Math.min(total, s.received + 0.9 * 1024 * 1024)
        if (url.includes(".invalid/fail")) {
          clearInterval(timer.current)
          return { ...s, state: "error", error: T("下载失败：服务器返回 404") }
        }
        if (received >= total) {
          clearInterval(timer.current)
          toast(T("GeoLite2 Country 已更新"))
          return { state: "complete", received, error: "", configured: true }
        }
        return { ...s, received }
      })
    }, 220)
  }
  const downloading = status.state === "downloading"
  return (
    <Card id="geo" title="GeoLite2 Country" icon="globe" aside={<span className="tag" data-tone={status.configured ? "ok" : undefined}>{status.configured ? T("已配置本地数据库") : T("未配置")}</span>}>
      <p className="muted">{T("使用本地数据库查询节点国家/地区。")}</p>
      <Field label={T("HTTPS 数据库直链")} error={url && !valid ? T("请填写不含账号信息的 HTTPS 地址") : status.state === "error" ? status.error : ""}>
        <Input className="mono" value={url} placeholder="https://example.com/GeoLite2-Country.mmdb" onChange={(e) => setUrl(e.target.value)} />
      </Field>
      {downloading && (
        <div className="progress-block" role="status">
          <span className="progress"><i style={{ width: `${(status.received / (9.3 * 1024 * 1024)) * 100}%` }}></i></span>
          <span className="muted small num">{T("已下载 {size}", { size: fmt.bytes(status.received) })}</span>
        </div>
      )}
      <div className="inspector-actions">
        <span className="dirty-note">{status.state === "complete" ? T("更新完成") : status.state === "cancelled" ? T("已取消") : ""}</span>
        {downloading && <Button onClick={() => { clearInterval(timer.current); setStatus({ ...status, state: "cancelled" }) }}>{T("取消")}</Button>}
        <Button icon={status.state === "error" ? "refresh-cw" : "download"} disabled={downloading || !valid} onClick={start}>{status.state === "error" ? T("重试") : T("下载并更新")}</Button>
      </div>
    </Card>
  )
}

function SettingsPage({ settings, setSettings, state, onRetry }) {
  const init = {
    site_name: settings.site_name, public_page: settings.public_page === "on", public_default_view: settings.public_default_view,
    retention_days: settings.retention_days, online_grace_minutes: settings.online_grace_minutes,
  }
  const form = useForm(init)
  const v = form.values
  const [busy, setBusy] = useState(false)
  const errors = {
    site_name: v.site_name.trim() ? "" : T("请填写站点名称"),
    retention_days: fmt.numericError(v.retention_days, { min: 1, max: 3650, required: true }),
    online_grace_minutes: fmt.numericError(v.online_grace_minutes, { min: 1, max: 60, required: true }),
  }
  const invalid = Object.values(errors).some(Boolean)
  const save = () => {
    if (invalid) return
    setBusy(true)
    later(() => {
      setSettings({ ...settings, ...v, public_page: v.public_page ? "on" : "off" })
      form.setValues(v)
      setBusy(false)
      toast(T("站点设置已保存"))
    })
  }
  return (
    <PageLoad state={state} onRetry={onRetry} label={T("设置")}>
      <div className="settings-layout">
        <Card id="site" title={T("站点")} icon="globe" className="card-wide">
          <div className="site-grid">
            <div className="inspector-form">
              <Field label={T("站点名称")} error={errors.site_name}><Input value={v.site_name} maxLength={64} onChange={(e) => form.set("site_name", e.target.value)} /></Field>
              <Switch checked={v.public_page} onChange={(x) => form.set("public_page", x)} label={T("开放公开状态页")} detail={T("关闭后所有页面需登录")} />
            </div>
            <div className="field">
              <span className="field-label">{T("公开页默认视图")}</span>
              <ViewChoice value={v.public_default_view} onChange={(x) => form.set("public_default_view", x)} />
              <p className="field-message"><span>{T("访客可临时切换，不影响这里的设置。")}</span></p>
            </div>
          </div>
        </Card>
        <Card id="history" title={T("历史与在线")} icon="history">
          <div className="inspector-form">
            <Field label={T("分钟历史保留天数")} hint={T("1–3650；小时历史保留一年")} error={errors.retention_days}><Input inputMode="numeric" value={v.retention_days} onChange={(e) => form.set("retention_days", e.target.value)} /></Field>
            <Field label={T("连续在线重置阈值（分钟）")} hint={T("1–60；中断超过此时长后重新计时")} error={errors.online_grace_minutes}><Input inputMode="numeric" value={v.online_grace_minutes} onChange={(e) => form.set("online_grace_minutes", e.target.value)} /></Field>
          </div>
        </Card>
        <GeoCard settings={settings} setSettings={setSettings} />
        <div className={cx("save-bar", form.dirty && "is-visible")} aria-hidden={!form.dirty}>
          <span>{T("有未保存的修改")}</span>
          <Button onClick={form.reset} tabIndex={form.dirty ? 0 : -1}>{T("放弃")}</Button>
          <Button kind="primary" busy={busy} disabled={invalid} onClick={save} tabIndex={form.dirty ? 0 : -1}>{T("保存站点设置")}</Button>
        </div>
      </div>
    </PageLoad>
  )
}

Object.assign(window, { Card, ProbesPage, NotifyPage, DataPage, SecurityPage, SettingsPage })
