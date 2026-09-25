function Fleet({onlineGrace=5,nodes,onOpen,onEdit,onCreate,onRegister,onCopy,state,onRetry}) {
  const [query,setQuery]=React.useState(""),[filter,setFilter]=React.useState("全部");
  const shown=nodes.filter(n=>[n.name,String(n.id),`node-${n.id}`,n.ip,n.ipv6].some(v=>String(v||"").toLowerCase().includes(query.toLowerCase()))&&(filter==="全部"||(filter==="在线"?n.online:!n.online)));
  return <section data-screen-id="nodes" data-screen-label="节点管理">
    <div className="page-head"><h1>节点管理</h1><div className="row head-actions"><Button onClick={onRegister}>批量注册</Button><Button kind="primary" onClick={onCreate}>添加节点</Button></div></div>
    {state==="offline"&&<Notice>连接已断开，正在重连。<Button onClick={onRetry}>重试</Button></Notice>}
    <div className="toolbar admin-node-toolbar"><label className="search"><span aria-hidden="true">⌕</span><input aria-label="搜索节点" placeholder="搜索名称、IP 或节点标识" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="segments" aria-label="节点状态筛选">{["全部","在线","离线"].map(v=><button key={v} aria-pressed={filter===v} onClick={()=>setFilter(v)}>{v}</button>)}</div>
    </div>
    {state==="loading"?<div className="skeleton" role="status" aria-label="正在加载节点"/>:state==="error"?<Empty error title="节点加载失败" action="重试" onAction={onRetry}/>:!shown.length?<Empty title={query?"没有匹配的节点":"还没有节点"} action={query?"清除搜索":"添加节点"} onAction={()=>query?setQuery(""):onCreate()}/>:<table className="node-table admin-node-list">
      <thead><tr><th>ID（优先级）</th><th>名称</th><th>IP</th><th>Agent 版本</th><th>接入标识</th><th>操作</th></tr></thead>
      <tbody>{shown.map(n=><tr key={n.id}>
        <td className="admin-id"><span className="admin-field-label">ID（优先级）</span><span className="admin-primary">{n.id} <span className="muted">({n.priority})</span></span></td>
        <td className="admin-name"><button className="text-button" onClick={()=>onOpen(n)}>{n.name}</button><Status node={n} grace={onlineGrace}/>{n.public===false&&<span className="muted small">私有</span>}</td>
        <td className="admin-addresses"><div className="address-line"><span>IPv4</span><CopyValue value={n.ip&&n.ip!=="—"?n.ip:null} label={`${n.name} IPv4`} onCopy={onCopy}/></div><div className="address-line"><span>IPv6</span><CopyValue value={n.ipv6} label={`${n.name} IPv6`} onCopy={onCopy}/></div></td>
        <td className="admin-version"><span className="admin-field-label">Agent 版本</span><span className="admin-primary">{n.agentVersion||"未上报"}</span></td>
        <td className="admin-identity"><span className="admin-field-label">接入标识</span><CopyValue value={`node-${n.id}`} label={`${n.name} 接入标识`} onCopy={onCopy}/></td>
        <td className="admin-menu"><Button kind="quiet" aria-label={`编辑菜单 ${n.name}`} onClick={()=>onEdit(n)}>编辑</Button></td>
      </tr>)}</tbody>
    </table>}
    <div className="table-foot"><span>{shown.length} 个节点</span><span>更新于 14:32:08</span></div>
  </section>;
}
function Detail({
  node,
  onBack,
  onManage,
  publicView = false,
  state,
  onRetry,
  onlineGrace=5,
}) {
  const [tab, setTab] = React.useState("资源"),
    [hours, setHours] = React.useState("24 小时");
  return (
    <section data-screen-id="node-detail" data-screen-label="节点详情">
      <div className="detail-top">
        <Button kind="quiet" onClick={onBack}>
          返回
        </Button>
        <div className="spacer"></div>
        <Status node={node} grace={onlineGrace} />
        {!publicView && (
          <Button onClick={() => onManage(node)}>管理节点</Button>
        )}
      </div>
      <div className="page-head">
        <div>

          <h1>{node.name}</h1>
          <p className="sub mono">
            {node.os} · {node.arch} · {node.region}
          </p>
        </div>
        <span className="muted small">
          连续在线 {romiView.continuity(node,onlineGrace)} · 本次启动 {node.online?node.uptime:"—"}
        </span>
      </div>
      {!node.online && <Notice>节点离线。历史数据仍可查看。</Notice>}
      <div className="kpis detail-kpis">
        {[
          ["CPU", node.online ? node.cpu + "%" : "—", node.cores?`${node.cores} vCPU`:"待上报"],
          ["RAM", node.online ? node.mem + "%" : "—", node.memGiB?`${node.memGiB} GiB`:"待上报"],
          ["磁盘", node.online ? node.disk + "%" : "—", node.diskGiB?`${node.diskGiB} GiB`:"待上报"],
          ["本期流量", node.traffic, "GB / " + node.limit + " GB"],
        ].map(([label, value, note]) => (
          <div className="kpi" key={label}>
            <div className="label">{label}</div>
            <strong>{["CPU","RAM","磁盘"].includes(label)?<UsageValue value={node.online?(label==="CPU"?node.cpu:label==="RAM"?node.mem:node.disk):null}/>:value}</strong>
            <div className="note">{note}</div>
          </div>
        ))}
      </div>
      <div className="detail-facts">
        <div>
          <span className="muted">系统</span>
          <p>{node.os}</p>
        </div>
        <div>
          <span className="muted">架构</span>
          <p className="mono">{node.arch}</p>
        </div>
        <div>
          <span className="muted">内核</span><p className="mono">{node.kernel}</p></div><div><span className="muted">可用带宽 · 上传 / 下载</span><p className="mono">{romiView.bandwidth(node.uploadMbps)} / {romiView.bandwidth(node.downloadMbps)}</p></div><div>
          <span className="muted">Agent 版本</span>
          <p className="mono">0.0.1</p>
        </div>
        {!publicView && (
          <div>
            <span className="muted">地址</span>
            <p className="mono">{node.ip}</p>
          </div>
        )}
        <div>
          <span className="muted">累计上传 / 下载</span>
          <p className="mono">{romiView.volume(node.totalUp)} / {romiView.volume(node.totalDown)}</p>
        </div>
      </div>
      <div className="row spread wrap history-toolbar">
        <div
          className="tabs"
          role="tablist"
          aria-label="历史类型"
          // A tab list is one stop, not three: Tab reaches the selected tab and
          // the arrows move between them. Without this a keyboard user pays
          // three stops to pass the control and gets no arrow behaviour, which
          // is what the role already promised.
          onKeyDown={(e) => {
            const order = ["资源", "监测", "流量"];
            const at = order.indexOf(tab);
            const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1
              : e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : null;
            if (to === null) return;
            e.preventDefault();
            const next = order[(to + order.length) % order.length];
            setTab(next);
            e.currentTarget.querySelector(`#tab-${next}`)?.focus();
          }}
        >
          {["资源", "监测", "流量"].map((v) => (
            <button
              key={v}
              id={`tab-${v}`}
              role="tab"
              aria-selected={tab === v}
              aria-controls={`tabpanel-${v}`}
              tabIndex={tab === v ? 0 : -1}
              onClick={() => setTab(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <label className="row small muted">
          时间范围
          <Select
            aria-label="时间范围"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          >
            {[
              "1 小时",
              "6 小时",
              "24 小时",
              "7 天",
              ...(!publicView ? ["30 天", "1 年"] : []),
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </Select>
        </label>
      </div>
      {state === "error" ? (
        <Empty
          error
          title="历史加载失败"
          detail="当前历史不可用，请稍后重试。"
          action="重试"
          onAction={onRetry}
        />
      ) : state === "empty" ? (
        <Empty
          title="暂无历史数据"
          detail="收到采样后，历史记录会显示在这里。"
        />
      ) : (
        // Named by its tab rather than repeating the label, so the two are one
        // control rather than two strings that can drift apart.
        <div id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="charts resource-charts">{romiView.plots(node,tab).map(plot=><ResourceChart key={plot.name} plot={plot} node={node} hours={hours}/>)}</div>
      )}

    </section>
  );
}
function Probes({ probes, onEdit, onDelete, state, onRetry }) {
  return (
    <section data-screen-id="probes" data-screen-label="监测">
      <PageTitle
        eyebrow="Network / TCP"
        title="监测"
        action={
          <Button kind="primary" onClick={() => onEdit()}>
            添加监测
          </Button>
        }
      />
      {state === "error" ? (
        <Empty
          error
          title="监测加载失败"
          detail="任务列表暂时不可用。"
          action="重试"
          onAction={onRetry}
        />
      ) : !probes.length || state === "empty" ? (
        <Empty
          title="还没有监测任务"
          detail="添加目标地址并选择执行监测的节点。"
          action="添加监测"
          onAction={() => onEdit()}
        />
      ) : (
        <div className="table-wrap">
          <table className="node-table probe-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>目标地址</th>
                <th>间隔</th>
                <th>节点</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {probes.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="mono">{p.target}</td>
                  <td className="mono">{p.interval}s</td>
                  <td>{p.nodes.length} 台</td>
                  <td>
                    <div className="ops">
                      <Button onClick={() => onEdit(p)}>编辑</Button>
                      <Button
                        kind="quiet"
                        onClick={() => onDelete(p)}
                        aria-label={`删除 ${p.name}`}
                      >
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function PageTitle({ eyebrow, title, subtitle, action }) {
  return (
    <div className="page-head">
      <div>

        <h1>{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
function SettingsScreen({ onSave, state, onRetry, settings, setSettings }) {
  const [dbState,setDbState] = React.useState("idle");
  const [dbMessage,setDbMessage] = React.useState("");
  const timer=React.useRef(null);
  React.useEffect(()=>()=>clearTimeout(timer.current),[]);
  function updateDatabase(form) {
    const field=form.elements.geoUrl;
    if (!field.checkValidity()) { field.focus(); return; }
    setDbState("loading");setDbMessage("");
    timer.current=setTimeout(()=>{
      const failed=new URL(field.value).hostname.endsWith(".invalid");
      setDbState(failed?"error":"ready");
      setDbMessage(failed?"下载失败，请检查地址后重试。":"数据库已更新");
    },600);
  }
  return <section data-screen-id="settings" data-screen-label="设置">
    <PageTitle title="站点设置" />
    {state==="error"?<Empty error title="设置加载失败" action="重试" onAction={onRetry}/>:<Form className="settings-list" onSubmit={e=>{e.preventDefault();const f=e.currentTarget.elements;setSettings({site:f.site.value,retention:f.retention.value,public:f.public.checked,defaultPublicView:f.defaultPublicView.value,geoUrl:f.geoUrl.value,onlineGrace:Number(f.onlineGrace.value)});localStorage.setItem("romi-prototype-v10-default-public-view",f.defaultPublicView.value);onSave("站点设置已保存");}}>
      <div className="box stack"><h2>站点与访问</h2><div className="form-grid">
        <Field label="站点名称" name="site" defaultValue={settings.site} required maxLength="64"/>
        <Field label="分钟历史保留天数" name="retention" type="number" min="1" max="365" defaultValue={settings.retention} hint="更早的数据按小时保留一年，累计流量不受影响。"/>
        <Field label="连续在线重置阈值（分钟）" name="onlineGrace" type="number" min="1" max="60" required defaultValue={settings.onlineGrace} hint="中断超过此时长，恢复后重新计时；本次启动随系统重启归零。" />
        <Field label="公开页默认视图"><Select name="defaultPublicView" defaultValue={settings.defaultPublicView}><option value="cards">卡片</option><option value="list">列表</option></Select></Field>
      </div><Check name="public" defaultChecked={settings.public}>开放公开状态页</Check></div>
      <div className="box stack"><h2>IP 地理位置</h2>
        <Field label="GeoLite2 Country 数据库下载地址" name="geoUrl" type="url" pattern="https://.+" required defaultValue={settings.geoUrl} hint="填写 HTTPS 的 .mmdb 文件直链。"/>
        <p className="muted small">使用本地数据库查询节点国家/地区。</p>
        <div className="row wrap"><Button type="button" disabled={dbState==="loading"} onClick={e=>updateDatabase(e.currentTarget.form)}>{dbState==="loading"?"下载中…":dbState==="error"?"重试下载":"下载并更新"}</Button>
        {dbState==="loading"&&<Button type="button" onClick={()=>{clearTimeout(timer.current);setDbState("idle");setDbMessage("下载已取消");}}>取消</Button>}
        <span className="muted small" role={dbState==="error"?"alert":"status"}>{dbMessage||"尚未下载"}</span></div>
      </div><div className="form-actions"><Button kind="primary" type="submit">保存设置</Button></div>
    </Form>}
  </section>;
}
function Notifications({ onSave, nodes, state, onRetry }) {
  const [busy,setBusy]=React.useState("");
  const [saved,setSaved]=React.useState({Telegram:true,Webhook:false});
  const [dirty,setDirty]=React.useState({Telegram:false,Webhook:false});
  const timer=React.useRef(null);
  React.useEffect(()=>()=>clearTimeout(timer.current),[]);
  function send(channel) {
    setBusy(channel);
    timer.current=setTimeout(()=>{setBusy("");onSave(`${channel} 测试通知已发送`);},600);
  }
  return (
    <section data-screen-id="notifications" data-screen-label="通知">
      <PageTitle title="通知" />
      {state === "error" ? (
        <Empty
          error
          title="通知设置加载失败"
          action="重试"
          onAction={onRetry}
        />
      ) : (
        <div className="settings-list">
          <Form
            className="box stack"
            onChange={()=>setDirty({...dirty,Telegram:true})}
            onSubmit={(e) => {
              e.preventDefault();
              setSaved({...saved,Telegram:true});setDirty({...dirty,Telegram:false});
              onSave("Telegram 已保存");
            }}
          >
            <div className="row spread">
              <h2>Telegram</h2>
              <span className="pill good">
                <i className="dot"></i>已配置
              </span>
            </div>
            <div className="form-grid">
              <Field
                label="Bot Token"
                type="password"
                placeholder="留空保持不变"
                autoComplete="off"
              />
              <Field label="Chat ID" defaultValue="-1000000000000" required />
            </div>
            <Field label="消息模板">
              <textarea
                defaultValue="{{title}}&#10;{{message}}"
              />
            </Field>
            <div className="form-actions">
              <span className="channel-hint">{dirty.Telegram?"有未保存的修改":saved.Telegram?"使用已保存的配置测试":"先保存渠道配置"}</span>
              <Button type="button" disabled={!saved.Telegram||dirty.Telegram||!!busy} onClick={()=>send("Telegram")}>{busy==="Telegram"?"发送中…":"测试 Telegram"}</Button>
              <Button kind="primary" type="submit">保存 Telegram</Button>
            </div>
          </Form>
          <Form
            className="box stack"
            onChange={()=>setDirty({...dirty,Webhook:true})}
            onSubmit={(e) => {
              e.preventDefault();
              setSaved({...saved,Webhook:true});setDirty({...dirty,Webhook:false});
              onSave("Webhook 已保存");
            }}
          >
            <div className="row spread">
              <h2>Webhook</h2>
              <span className="muted small">{saved.Webhook?"已配置":"未配置"}</span>
            </div>
            <Field
              label="URL"
              type="url"
              placeholder="https://notify.example.invalid/hook"
              required
            />
            <div className="form-grid">
              <Field label="请求头">
                <textarea placeholder="Header: value" />
              </Field>
              <Field label="JSON 请求体">
                <textarea
                  defaultValue={JSON.stringify({
                    content: "{{title}}\n{{message}}",
                  })}
                  onInput={(e) => {
                    try {
                      JSON.parse(e.currentTarget.value);
                      e.currentTarget.setCustomValidity("");
                    } catch {
                      e.currentTarget.setCustomValidity("请输入有效 JSON");
                    }
                  }}
                />
              </Field>
            </div>
            <div className="form-actions">
              <span className="channel-hint">{dirty.Webhook?"有未保存的修改":saved.Webhook?"使用已保存的配置测试":"先保存渠道配置"}</span>
              <Button type="button" disabled={!saved.Webhook||dirty.Webhook||!!busy} onClick={()=>send("Webhook")}>{busy==="Webhook"?"发送中…":"测试 Webhook"}</Button>
              <Button kind="primary" type="submit">保存 Webhook</Button>
            </div>
          </Form>
          <Form
            className="box stack"
            onSubmit={(e) => {
              e.preventDefault();
              onSave("提醒规则已保存");
            }}
          >
            <h2>提醒规则</h2>
            <div className="form-grid">
              <Field
                label="离线宽限期（分钟）"
                type="number"
                min="1"
                max="30"
                defaultValue="3"
              />
              <Field
                label="流量提醒（%）"
                type="number"
                min="0"
                max="100"
                defaultValue="80"
              />
              <Field
                label="到期提醒（天）"
                type="number"
                min="0"
                defaultValue="7"
              />
            </div>
            <fieldset className="choice-group">
            <legend>离线与恢复通知</legend>
            <div className="choice-list choice-columns">
              {nodes.slice(0, 4).map((n) => (
                <Check key={n.id} defaultChecked>
                  {n.name}
                </Check>
              ))}
            </div>
            </fieldset>
            <div className="form-actions">
              <Button kind="primary" type="submit">
                保存规则
              </Button>
            </div>
          </Form>
        </div>
      )}
    </section>
  );
}
function Security({ onSave, onConfirm, account, setAccount, state, onRetry }) {
  // The hub answers a wrong current password with a refusal, so the form has to
  // show one. `romi-prototype` is this fixture's stand-in for the stored value.
  const [currentPasswordError, setCurrentPasswordError] = React.useState("");
  return (
    <section data-screen-id="security" data-screen-label="安全">
      <PageTitle eyebrow="Account / Security" title="安全" />
      <div className="settings-list">
        <Form
          className="box stack"
          onSubmit={(e) => {
            e.preventDefault();
            const form=e.currentTarget;
            const nextAccount=form.elements.account.value;
            if (form.elements.current.value!=="romi-prototype") {
              setCurrentPasswordError("当前密码不正确");
              form.elements.current.focus();
              return;
            }
            setCurrentPasswordError("");
            onConfirm(
              "修改账号与密码",
              "修改后所有现有会话都会失效，需要重新登录。",
              () => { setAccount(nextAccount); onSave("账号与密码已修改，请重新登录"); },
            );
          }}
        >
          <h2>账号与密码</h2>
          <Field label="账号" name="account" defaultValue={account} required autoComplete="username" />
          <Field
            label="当前密码"
            name="current"
            type="password"
            required
            autoComplete="current-password"
            hint="修改账号或密码都需要先验证当前密码。"
            error={currentPasswordError}
            onChange={() => setCurrentPasswordError("")}
          />
          <Field
            label="新密码"
            type="password"
            minLength="12"
            required
            autoComplete="new-password"
            hint="至少 12 位。"
          />
          <div className="form-actions">
            <Button type="submit">修改密码</Button>
          </div>
        </Form>
        <div className="box">
          <div className="box-head">
            <h2>登录会话</h2>
            {state !== "sessions-error" && <span className="muted small">2 个</span>}
          </div>
          {/* The list fails on its own while the rest of the page works, so the
              card says so where the list would be. An absent card read as "no
              other sessions", which is the one thing it cannot know. */}
          {state === "sessions-error" ? (
            <Empty
              error
              title="会话列表加载失败"
              detail="暂时无法确认其他设备的登录状态。"
              action="重试"
              onAction={onRetry}
            />
          ) : ["当前浏览器", "另一台浏览器"].map((name, i) => (
            <div className="data-row" key={name}>
              <div>
                <h3>{name}</h3>
                <p className="muted mono">
                  {i ? "192.0.2.21 · 2 小时前" : "192.0.2.20 · 刚刚活跃"}
                </p>
              </div>
              <Button
                kind="quiet"
                onClick={() =>
                  onConfirm("撤销会话", "该浏览器需要重新登录。", () =>
                    onSave("会话已撤销"),
                  )
                }
              >
                撤销
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
function DataScreen({ onSave, onRestore, onConfirm, state, onRetry, maintenance, setMaintenance }) {
  const [interval,setIntervalDays]=React.useState(maintenance);
  return (
    <section data-screen-id="data" data-screen-label="数据">
      <PageTitle eyebrow="Storage / History" title="数据" />
      {state === "error" ? (
        <Empty
          error
          title="数据统计加载失败"
          action="重试"
          onAction={onRetry}
        />
      ) : (
        <div className="settings-list">
          <div className="box">
            <div className="box-head">
              <h2>历史数据</h2>
              <span className="muted small">更新于 14:32</span>
            </div>
            <div className="stat-grid">
              <div>
                <span className="muted small">数据库占用</span>
                <strong>124.8 MB</strong>
              </div>
              <div>
                <span className="muted small">分钟历史</span>
                <strong>30 天</strong>
              </div>
              <div>
                <span className="muted small">小时历史</span>
                <strong>365 天</strong>
              </div>
            </div>
          </div>
          <div className="box stack">
            <h2>备份与恢复</h2>
            <p className="muted small">
              恢复会替换现有数据并结束登录会话，请先保留当前备份。
            </p>
            <div className="row wrap">
              <Button onClick={() => onSave("备份已准备完成")}>
                下载备份
              </Button>
              <Button onClick={onRestore}>从备份恢复</Button>
            </div>
          </div>
          <div className="box stack">
            <h2>数据库维护</h2>
            <Form className="stack" onSubmit={e=>{e.preventDefault();setMaintenance(interval);onSave("自动维护设置已保存");}}>
              <Field label="自动维护周期"><Select value={interval} onChange={e=>setIntervalDays(e.target.value)}><option value="0">关闭</option>{[7,30,90,180].map(days=><option key={days} value={String(days)}>每 {days} 天</option>)}</Select></Field>
              <div className="row spread"><span className="muted small">{maintenance==="0"?"自动维护已关闭":`已启用 · 每 ${maintenance} 天`}</span><Button type="submit">保存周期</Button></div>
            </Form>
            <p className="muted small">
              清理超过保留期的数据并检查可复用空间。累计流量不会减少。
            </p>
            <div>
              <Button
                onClick={() =>
                  onConfirm(
                    "执行维护",
                    "维护期间可能暂时增加磁盘和 CPU 使用。",
                    () => onSave("维护已完成"),
                  )
                }
              >
                执行维护
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
function PublicNodeList({nodes,onlineGrace}) {
  return <table className="node-table public-list"><thead><tr><th>节点 / 系统</th><th>状态</th><th>CPU</th><th>RAM</th><th>磁盘</th><th>上传 / 下载</th><th>本期 / 额度</th></tr></thead><tbody>
    {nodes.map(n=><tr key={n.id}>
      <td className="public-node"><a href={"#node-"+n.id}>{n.name}</a><div className="meta">{n.os} · {n.arch}</div></td>
      <td className="public-status"><Status node={n} grace={onlineGrace}/></td>
      <td><span className="list-label">CPU</span><Meter value={n.online?n.cpu:null}/></td>
      <td><span className="list-label">RAM</span><Meter value={n.online?n.mem:null}/></td>
      <td><span className="list-label">磁盘</span><Meter value={n.online?n.disk:null}/></td>
      <td className="public-transfer"><span className="list-label">上传 / 下载</span><RatePair node={n}/></td>
      <td className="public-traffic"><span className="list-label">本期 / 额度</span><span>{romiView.volume(n.traffic)} / {n.limit?romiView.volume(n.limit):"不限"}</span></td>
    </tr>)}
  </tbody></table>;
}
function PublicFleet({ nodes, state, onRetry, onlineGrace=5, view, setView }) {
  return <section data-screen-id="public" data-screen-label="公开节点">
    <PageTitle title="节点状态" action={<span className="muted small">{state==="offline"?"连接中断":"实时连接"}</span>}/>
    <KPIs nodes={nodes}/>
    <div className="public-toolbar"><ViewSwitch view={view} onChange={setView}/></div>
    <div className="public-results" data-view={view}>
    {state==="error"?<Empty error title="暂时无法加载" action="重试" onAction={onRetry}/>:!nodes.length?<Empty title="还没有公开节点" detail="管理员公开节点后会显示在这里。"/>:view==="list"?<PublicNodeList nodes={nodes} onlineGrace={onlineGrace}/>:<div className="public-grid">
      {/* No aria-label: one on the card replaces everything inside it, so a
          screen reader hears "查看 <名称>" and never the status, billing or
          resources the card exists to show. The list view already names its
          link from its own text. */}
      {nodes.map(n=><a className="node-card" key={n.id} href={"#node-"+n.id}>
        <div className="row spread"><h2>{n.name}</h2><Status node={n} grace={onlineGrace}/></div>
        <div className="card-billing"><strong>{n.price?`${n.currency} ${Number(n.price).toFixed(2)} / ${n.cycle}`:"免费"}</strong><span>{romiView.remaining(n.expires)}</span></div>
        <div className="system-facts"><div className="system-line"><span>{n.os==="—"?"等待首次上报":n.os}</span><span>内核 {n.kernel}</span></div><span>{n.cpuName?`${n.cpuName} · ${n.cores} vCPU · ${n.arch}`:"CPU 待上报"}</span></div>
        <div className="resource-grid">
          <div><Meter label="CPU" value={n.online?n.cpu:null}/><small>{n.cores?`${n.cores} vCPU`:"待上报"}</small></div>
          <div><Meter label="RAM" value={n.online?n.mem:null}/><small>{n.online?(n.memGiB*n.mem/100).toFixed(1)+" / ":""}{n.memGiB?`${n.memGiB} GiB`:"待上报"}</small></div>
          <div><Meter label="磁盘" value={n.online?n.disk:null}/><small>{n.online?(n.diskGiB*n.disk/100).toFixed(1)+" / ":""}{n.diskGiB?`${n.diskGiB} GiB`:"待上报"}</small></div>
        </div>
        <table className="card-network"><thead><tr><th scope="col">网络</th><th scope="col">上传</th><th scope="col">下载</th></tr></thead><tbody>
          <tr><th scope="row">可用带宽</th><td>{romiView.bandwidth(n.uploadMbps)}</td><td>{romiView.bandwidth(n.downloadMbps)}</td></tr>
          <tr><th scope="row">实时速率</th><td>{n.online?n.tx.toFixed(1)+" MiB/s":"—"}</td><td>{n.online?n.rx.toFixed(1)+" MiB/s":"—"}</td></tr>
          <tr><th scope="row">累计流量</th><td>{romiView.volume(n.totalUp)}</td><td>{romiView.volume(n.totalDown)}</td></tr>
        </tbody></table>
        <div className="period-traffic"><span>本期流量</span><strong>{romiView.volume(n.traffic)} <small>/ {n.limit?romiView.volume(n.limit):"不限"}</small></strong></div>
        <div className="card-foot"><span>连续在线 <b>{romiView.continuity(n,onlineGrace)}</b></span><span>本次启动 <b>{n.online?n.uptime:"—"}</b></span></div>
        {!n.online&&n.uptime!=="尚未连接"&&<p className="card-outage">{n.gapMinutes<=onlineGrace?`中断 ${n.gapMinutes} 分钟 · 在线时段暂保留`:`已离线 ${n.gapMinutes} 分钟`}</p>}
      </a>)}
    </div>}
    </div>
  </section>;
}
Object.assign(window, {
  Fleet,
  Detail,
  Probes,
  PageTitle,
  SettingsScreen,
  Notifications,
  Security,
  DataScreen,
  PublicFleet,
});
