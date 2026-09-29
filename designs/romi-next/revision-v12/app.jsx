const { useState, useEffect } = React;
const layout = document.documentElement.dataset.layout;
const publicView = document.documentElement.dataset.audience === "public";
const params = new URLSearchParams(location.search);
function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "nodes");
  const [theme, setTheme] = useState(
    params.get("theme") ||
      localStorage.getItem("romi-prototype-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  const [nodes, setNodes] = useState(
    params.get("state") === "empty" &&
      (!location.hash || location.hash === "#nodes")
      ? []
      : romiFixtures.nodes.map((n) => ({
          ...n,
        })),
  );
  const [probes, setProbes] = useState(
    romiFixtures.probes.map((p) => ({
      ...p,
    })),
  );
  const [state, setState] = useState(params.get("state") || "ready");
  const [modal, setModal] = useState(null),
    [toast, setToast] = useState("");
  const [menu, setMenu] = useState(false),
    [logged, setLogged] = useState(params.get("state") !== "login");
  const [railQuery, setRailQuery] = useState("");
  const [publicLayout,setPublicLayout]=useState(()=>localStorage.getItem("romi-prototype-v10-default-public-view")==="list"?"list":"cards");
  const [account,setAccount]=useState("admin");
  const [maintenance,setMaintenance]=useState("0");
  const [settings,setSettings]=useState({site:"romi",retention:"30",public:true,defaultPublicView:localStorage.getItem("romi-prototype-v10-default-public-view")==="list"?"list":"cards",onlineGrace:5,geoUrl:"https://git.via.moe/dejavu/GeoLite.mmdb/releases/download/latest/GeoLite2-Country.mmdb"});
  useEffect(() => {
    const sync = () => {
      setRoute(location.hash.slice(1) || "nodes");
      setMenu(false);
      scrollTo(0, 0);
    };
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("romi-prototype-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  const go = (to) => {
    if (location.hash.slice(1) === to) {
      setRoute(to);
      setMenu(false);
    } else location.hash = to;
  };
  const retry = () => {
    setState("ready");
    setToast("连接已恢复");
  };
  const confirm = (title, detail, action) =>
    setModal({
      kind: "confirm",
      title,
      detail,
      action,
    });
  const edit = (node) =>
    setModal({
      kind: "node",
      node,
    });
  const create = () =>
    setModal({
      kind: "create",
    });
  const selected =
    nodes.find((n) => n.id === Number(route.replace("node-", ""))) ||
    (layout === "workspace" && route === "nodes" ? nodes[0] : null);
  // The status page shows only what the operator published; the management list
  // shows every node and marks the private ones.
  const shown = publicView ? nodes.filter((n) => n.public !== false) : nodes;
  const allowedSelected = selected;
  const routeKey = route.startsWith("node-") ? "nodes" : route;
  const label = romiFixtures.nav.find((n) => n[0] === routeKey)?.[1] || "节点";
  const links = (drawer = false) => (
    <nav className={drawer ? "drawer-nav" : "side-nav"} aria-label="主导航">
      {romiFixtures.nav.map(([id, title, index]) => (
        <a
          key={id}
          href={`#${id}`}
          aria-current={routeKey === id ? "page" : undefined}
          onClick={() => setMenu(false)}
        >
          <span>{index}</span>
          <span>{title}</span>
        </a>
      ))}
    </nav>
  );
  function content() {
    if (state === "permission")
      return (
        <Empty
          title="需要登录"
          detail="当前会话已失效，请重新登录后继续。"
          action="前往登录"
          onAction={() => {
            if (publicView) {
              location.href = "index.html?state=login";
              return;
            }
            setLogged(false);
            setState("ready");
          }}
        />
      );
    if (state === "loading")
      return (
        <>
          <PageTitle title={label} />
          <div className="skeleton" role="status" aria-label="正在加载"></div>
        </>
      );
    if (route.startsWith("node-") && !allowedSelected)
      return (
        <Empty
          title="节点不存在"
          detail="请返回列表选择可以访问的节点。"
          action="返回节点"
          onAction={() => go("nodes")}
        />
      );
    if (allowedSelected)
      return (
        <div className="node-workspace">
          {layout === "workspace" && (
            <aside className="rail" aria-label="节点选择">
              <label className="field">
                <span>搜索节点</span>
                <input
                  value={railQuery}
                  onChange={(e) => setRailQuery(e.target.value)}
                  aria-label="搜索工作区节点"
                />
              </label>
              <Button kind="primary" onClick={create}>
                添加节点
              </Button>
              {nodes
                .filter((n) =>
                  n.name.toLowerCase().includes(railQuery.toLowerCase()),
                )
                .map((n) => (
                  <button
                    key={n.id}
                    className={selected.id === n.id ? "active" : ""}
                    onClick={() => go("node-" + n.id)}
                  >
                    {n.name}
                    <small>
                      {n.online ? "在线" : "离线"} · {n.os}
                    </small>
                  </button>
                ))}
            </aside>
          )}
          <Detail onlineGrace={settings.onlineGrace}
            key={selected.id}
            node={selected}
            onBack={() => go("nodes")}
            onManage={edit}
            publicView={publicView}
            state={state}
            onRetry={retry}
          />
        </div>
      );
    if (publicView)
      return (
        <PublicFleet view={publicLayout} setView={setPublicLayout} onlineGrace={settings.onlineGrace}
          nodes={shown}
          onOpen={(n) => go("node-" + n.id)}
          state={state}
          onRetry={retry}
        />
      );
    if (state === "loading" && route !== "nodes")
      return (
        <>
          <PageTitle title={label} />
          <div className="skeleton" role="status" aria-label="正在加载"></div>
        </>
      );
    if (state === "error" && ["security", "themes"].includes(route))
      return (
        <Empty
          error
          title={label + "加载失败"}
          action="重试"
          onAction={retry}
        />
      );
    switch (route) {
      case "probes":
        return (
          <Probes
            probes={probes}
            state={state}
            onRetry={retry}
            onEdit={(probe) =>
              setModal({
                kind: "probe",
                probe,
              })
            }
            onDelete={(p) =>
              confirm("删除监测", `删除“${p.name}”并停止下发此任务？`, () => {
                setProbes(probes.filter((x) => x.id !== p.id));
                setToast("监测已删除");
              })
            }
          />
        );
      case "notifications":
        return (
          <Notifications
            onSave={setToast}
            nodes={nodes}
            state={state}
            onRetry={retry}
          />
        );
      case "settings":
        return (
          <SettingsScreen onSave={setToast} state={state} onRetry={retry} settings={settings} setSettings={setSettings} />
        );
      case "security":
        return <Security onSave={setToast} onConfirm={confirm} account={account} setAccount={setAccount} state={state} onRetry={retry} />;
      case "data":
        return (
          <DataScreen maintenance={maintenance} setMaintenance={setMaintenance}
            onSave={setToast}
            state={state}
            onRetry={retry}
            onRestore={() =>
              setModal({
                kind: "restore",
              })
            }
            onConfirm={confirm}
          />
        );
      default:
        return (
          <Fleet onlineGrace={settings.onlineGrace} onCopy={setToast}
            nodes={nodes}
            onOpen={(n) => go("node-" + n.id)}
            onEdit={edit}
            onCreate={create}
            onRegister={() =>
              setModal({
                kind: "registration",
              })
            }
            state={state}
            onRetry={retry}
          />
        );
    }
  }
  const themeButton = (
    <Button
      kind="quiet icon"
      aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? "☼" : "◐"}
    </Button>
  );
  const brand = (
    <a className="brand" href="#nodes" aria-label="romi 节点首页">
      romi
    </a>
  );
  if (!logged && !publicView)
    return (
      <>
        <div className="login" data-screen-id="login" data-screen-label="登录">
          <h1>登录</h1>

          <Form
            className="box"
            onSubmit={(e) => {
              e.preventDefault();
              setLogged(true);
              go("nodes");
              setToast("已登录");
            }}
          >
            <Field label="账号" name="account" autoComplete="username" required placeholder="输入账号" />
            <Field
              label="密码"
              type="password"
              autoComplete="current-password"
              required
              placeholder="输入密码"
            />
            <Button kind="primary" type="submit">
              登录
            </Button>
          </Form>
          <small>
            <a href="public.html">返回公开状态页</a>
          </small>
        </div>
      </>
    );
  return (
    <>
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳转到内容
      </a>
      {publicView ? (
        <div className="public-shell">
          <header className="topbar">
            {brand}
            <div className="spacer"></div>
            <a href="index.html?state=login" className="small">
              登录
            </a>
            {themeButton}
          </header>
          <main id="main" className="content" tabIndex="-1">
            {content()}
          </main>
          <footer className="footer">
            <span className="mono">romi / 0.0.1</span>
            <span>更新于 14:32:08</span>
          </footer>
        </div>
      ) : (
        <div className="shell">
          <aside className="sidebar">
            {" "}
            <div>
              {brand}

            </div>
            {links()}
            <div className="side-footer">
              <div className="status-line">
                <i className="dot"></i>{" "}
                {state === "offline" ? "连接中断" : "数据连接"}
              </div>
              <a href="public.html">公开状态页</a>
              <span className="mono muted">v0.0.1</span>
            </div>
          </aside>
          <div className="main-shell">
            <div className="workspace-nav">
              {brand}
              <nav aria-label="主导航">
                {romiFixtures.nav.map(([id, title]) => (
                  <a
                    key={id}
                    href={`#${id}`}
                    aria-current={routeKey === id ? "page" : undefined}
                  >
                    {title}
                  </a>
                ))}
              </nav>
            </div>
            <header className="topbar">
              <Button
                className="mobile-menu"
                kind="quiet icon"
                aria-label="打开导航"
                aria-expanded={menu}
                aria-controls="navigation-drawer"
                onClick={() => setMenu(true)}
              >
                ≡
              </Button>
              <span className="crumb">
                管理后台 <span aria-hidden="true">/</span>{" "}
                <span
                  style={{
                    color: "var(--text)",
                  }}
                >
                  {label}
                </span>
              </span>
              <div className="spacer"></div>
              <span className={`pill ${state === "offline" ? "warn" : "good"}`}>
                <i className="dot"></i>
                {state === "offline" ? "连接中断" : "实时连接"}
              </span>
              {themeButton}
              <Button
                kind="quiet"
                onClick={() => {
                  setLogged(false);
                  setToast("");
                }}
              >
                退出
              </Button>
            </header>
            <main id="main" className="content" tabIndex="-1">
              {content()}
            </main>
          </div>
        </div>
      )}
      {menu && (
        <Modal title="导航" id="navigation-drawer" className="nav-drawer" onClose={() => setMenu(false)}>
          {links(true)}
          <div className="form-actions">
            <a href="public.html">公开状态页</a>
          </div>
        </Modal>
      )}
      {modal && (
        <ActionDialog onlineGrace={settings.onlineGrace}
          modal={modal}
          close={() => setModal(null)}
          replace={setModal}
          nodes={nodes}
          setNodes={setNodes}
          probes={probes}
          setProbes={setProbes}
          notify={setToast}
          go={go}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
function ActionDialog({
  onlineGrace=5,
  modal,
  close,
  replace,
  nodes,
  setNodes,
  probes,
  setProbes,
  notify,
  go,
}) {
  const [progress, setProgress] = useState(null),
    [busy, setBusy] = useState(false),
    [register, setRegister] = useState(true);
  const [reportInterval,setReportInterval]=useState("3");
  const reportError=romiView.numericError(reportInterval,{min:3,max:60,step:1,required:true});
  const installCommand=reportError?"":`curl -fsSL https://hub.example.invalid/install.sh -o install.sh\nsudo sh install.sh --server https://hub.example.invalid --interval ${reportInterval}`;
  const timer = React.useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  const n = modal.node,
    p = modal.probe;
  const [limit,setLimit]=useState(String((n?.limit || 0)/(n?.quotaUnit==="TB"?1024:1)));
  const [unit,setUnit]=useState(n?.quotaUnit || "GB");
  const [sameBandwidth,setSameBandwidth]=useState((n?.uploadMbps??1000)===(n?.downloadMbps??1000));
  const [downUnit,setDownUnit]=useState((n?.downloadMbps??1000)>=1000?"Gbps":"Mbps");
  const [upUnit,setUpUnit]=useState((n?.uploadMbps??1000)>=1000?"Gbps":"Mbps");
  const [downValue,setDownValue]=useState(String((n?.downloadMbps??1000)/((n?.downloadMbps??1000)>=1000?1000:1)));
  const [upValue,setUpValue]=useState(String((n?.uploadMbps??1000)/((n?.uploadMbps??1000)>=1000?1000:1)));
  const finish = (text) => {
    close();
    notify(text);
  };
  const titles = {
    create: "添加节点",
    node: n?.name,
    edit: "编辑节点",
    billing: "账单与流量",
    install: "安装 Agent",
    probe: p ? "编辑监测" : "添加监测",
    registration: "批量注册",
    restore: "恢复备份",
    token: "一次性令牌",
    confirm: modal.title,
  };
  const submit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    if (modal.kind === "create") {
      const id = Math.max(0, ...nodes.map((x) => x.id)) + 1;
      setNodes([
        ...nodes,
        {
          ...romiFixtures.nodes[5],
          id,
          name: data.name,
        },
      ]);
      replace({
        kind: "token",
      });
      return;
    }
    if (modal.kind === "edit") {
      setNodes(
        nodes.map((x) =>
          x.id === n.id
            ? {
                ...x,
                name: data.name,
                mode: data.mode,
                reset: Number(data.reset),
                limit: Number(data.limit) * (unit==="TB"?1024:1),
                priority: Number(data.priority), quotaUnit: unit,
                public: data.visibility!=="private",
                hasIPv4: data.ipv4==="yes", hasIPv6: data.ipv6==="yes",
                downloadMbps:Number(downValue)*(downUnit==="Gbps"?1000:1),
                uploadMbps:sameBandwidth?Number(downValue)*(downUnit==="Gbps"?1000:1):Number(upValue)*(upUnit==="Gbps"?1000:1),
                remark: data.remark,
              }
            : x,
        ).sort((a,b)=>b.priority-a.priority || a.id-b.id),
      );
      finish("节点已保存");
      return;
    }
    if (modal.kind === "billing") {
      setNodes(
        nodes.map((x) =>
          x.id === n.id
            ? {
                ...x,
                price: data.price, currency:data.currency, cycle:data.cycle,
                expires: data.expires,
                traffic: Number(data.traffic),
              }
            : x,
        ),
      );
      finish("账单与流量已保存");
      return;
    }
    if (modal.kind === "probe") {
      const form = e.currentTarget;
      const target = data.target;
      if (!/^[^\s]+:\d+$/.test(target)) {
        form.elements.target.setCustomValidity("请输入 host:port");
        form.elements.target.checkValidity();
        form.elements.target.focus();
        return;
      }
      const row = {
        id: p?.id || Math.max(0, ...probes.map((x) => x.id)) + 1,
        name: data.name,
        target,
        interval: Number(data.interval),
        nodes: new FormData(form).getAll("nodes").map(Number),
      };
      setProbes(
        p ? probes.map((x) => (x.id === p.id ? row : x)) : [...probes, row],
      );
      finish("监测已保存，正在下发");
      return;
    }
  };
  function restore(e) {
    e.preventDefault();
    setBusy(true);
    setProgress(0);
    let value = 0;
    timer.current = setInterval(() => {
      value += 20;
      setProgress(value);
      if (value >= 100) {
        clearInterval(timer.current);
        setBusy(false);
        notify("恢复完成，需要重新登录");
      }
    }, 350);
  }
  return (
    <Modal title={titles[modal.kind] || "确认"} onClose={close}>
      {modal.kind === "confirm" ? (
        <>
          <p>{modal.detail}</p>
          <div className="form-actions">
            <Button onClick={close}>取消</Button>
            <Button
              kind="danger"
              onClick={() => {
                modal.action();
                close();
              }}
            >
              确认
            </Button>
          </div>
        </>
      ) : modal.kind === "node" ? (
        <>
          <div
            className="row spread"
            style={{
              marginBottom: 20,
            }}
          >
            <Status node={n} grace={onlineGrace} />
            <span className="mono muted small">
              {n.os} · {n.arch}
            </span>
          </div>
          <div className="stack">
            {[
              ["edit", "编辑节点"],
              ["billing", "账单与流量"],
              ["install", "安装 Agent"],
            ].map(([kind, title]) => (
              <Button
                key={kind}
                onClick={() =>
                  replace({
                    kind,
                    node: n,
                  })
                }
              >
                {title}
              </Button>
            ))}
            <Button
              kind="danger"
              onClick={() =>
                replace({
                  kind: "confirm",
                  title: "删除节点",
                  detail: `删除“${n.name}”及其历史数据？此操作不可撤销。`,
                  action: () => {
                    setNodes(nodes.filter((x) => x.id !== n.id));
                    go("nodes");
                    notify("节点已删除");
                  },
                })
              }
            >
              删除节点
            </Button>
          </div>
        </>
      ) : ["create", "edit", "billing", "probe"].includes(modal.kind) ? (
        <Form onSubmit={submit} className="stack">
          {modal.kind === "create" ? (
            <>
              <Field
                label="名称"
                name="name"
                required
                maxLength="128"
                placeholder="例如：东京 · edge-02"
              />
              <p className="muted small">
                创建后请保存一次性令牌。
              </p>
            </>
          ) : modal.kind === "edit" ? (
            <>
              <Field label="名称" name="name" required defaultValue={n.name} />
              <div className="form-grid">
                <div className="quota-field"><Field label="每月流量额度" name="limit" type="number" min="0" step="any" required value={limit} onChange={e=>setLimit(e.target.value)} hint="0 表示不限"/><Field label="单位"><Select value={unit} onChange={e=>{const next=e.target.value;setLimit(limit===""?"":String(Number(limit)*(next==="TB"?1/1024:1024)));setUnit(next);}}><option>GB</option><option>TB</option></Select></Field></div>
                <Field label="计费方式">
                  <Select name="mode" defaultValue={n.mode || "sum"}>
                    <option value="sum">双向合计</option>
                    <option value="up">仅上传</option>
                    <option value="down">仅下载</option>
                    <option value="max">双向取大</option>
                  </Select>
                </Field>
                <Field
                  label="每月重置日"
                  type="number"
                  name="reset"
                  min="1"
                  max="31"
                  defaultValue={n.reset || 1}
                  required
                  hint="每月 1–31 日，默认 1 日。"
                />
                <Field label="展示优先级" name="priority" type="number" step="1" min="0" max="999999" required defaultValue={n.priority || 0} hint="0–999999 的整数，数值越大越靠前。" />
                <Field label="公开状态页" hint="私有节点只在管理列表显示。"><Select name="visibility" defaultValue={n.public===false?"private":"public"}><option value="public">显示</option><option value="private">不显示</option></Select></Field>
                <Field label="IPv4"><Select name="ipv4" defaultValue={n.hasIPv4?"yes":"no"}><option value="no">无</option><option value="yes">有</option></Select></Field>
                <Field label="IPv6"><Select name="ipv6" defaultValue={n.hasIPv6?"yes":"no"}><option value="no">无</option><option value="yes">有</option></Select></Field>
              </div>
              <fieldset className="bandwidth-fields"><legend>可用带宽</legend>
                <div className="quota-field"><Field label="下载带宽" type="number" min="0" step="any" required value={downValue} onChange={e=>setDownValue(e.target.value)}/><Field label="下载带宽单位"><Select value={downUnit} onChange={e=>{const unit=e.target.value;setDownValue(downValue===""?"":String(Number(downValue)*(unit==="Gbps"?0.001:1000)));setDownUnit(unit);}}><option>Mbps</option><option>Gbps</option></Select></Field></div>
                <Check checked={sameBandwidth} onChange={e=>setSameBandwidth(e.target.checked)}>上传与下载相同</Check>
                {!sameBandwidth&&<div className="quota-field"><Field label="上传带宽" type="number" min="0" step="any" required value={upValue} onChange={e=>setUpValue(e.target.value)}/><Field label="上传带宽单位"><Select value={upUnit} onChange={e=>{const unit=e.target.value;setUpValue(upValue===""?"":String(Number(upValue)*(unit==="Gbps"?0.001:1000)));setUpUnit(unit);}}><option>Mbps</option><option>Gbps</option></Select></Field></div>}
              </fieldset>
              <Field
                label="备注"
                name="remark"
                defaultValue={n.remark || ""}
                hint="仅管理员可见。"
              />
            </>
          ) : modal.kind === "billing" ? (
            <>
              <div className="form-grid">
                <Field
                  label="价格"
                  name="price"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={n.price ?? "5.00"}
                />
                <Field label="货币">
                  <Select name="currency" defaultValue={n.currency || "USD"}>
                    <option>USD</option>
                    <option>CNY</option>
                    <option>EUR</option>
                  </Select>
                </Field>
                <Field label="付款周期">
                  <Select name="cycle" defaultValue={n.cycle || "月付"}>
                    <option>月付</option>
                    <option>年付</option>
                    <option>一次性</option>
                  </Select>
                </Field>
                <Field
                  label="到期时间"
                  type="date"
                  name="expires"
                  defaultValue={n.expires ?? ""}
                />
              </div>
              <Field
                label="本期流量修正（GB）"
                name="traffic"
                type="number"
                min="0"
                defaultValue={n.traffic}
              />
              <Notice>确认修改前，请核对计费周期与流量。</Notice>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Field
                  label="名称"
                  name="name"
                  required
                  defaultValue={p?.name || ""}
                />
                <Field
                  label="间隔（秒）"
                  name="interval"
                  type="number"
                  min="5"
                  max="3600"
                  required
                  defaultValue={p?.interval || 60}
                />
              </div>
              <Field
                label="目标地址"
                name="target"
                placeholder="status.example.invalid:443"
                required
                defaultValue={p?.target || ""}
                onInput={(e) => e.target.setCustomValidity("")}
              />
              <fieldset className="choice-group">
                <legend>执行节点</legend>
                <div className="choice-list">
                {nodes.map((x) => (
                  <Check
                    key={x.id}
                    name="nodes"
                    value={x.id}
                    defaultChecked={p ? p.nodes.includes(x.id) : x.online}
                  >
                    {x.name}
                  </Check>
                ))}
                </div>
              </fieldset>
            </>
          )}
          <div className="form-actions">
            <Button type="button" onClick={close}>
              取消
            </Button>
            <Button kind="primary" type="submit">
              {modal.kind === "create" ? "创建节点" : "保存"}
            </Button>
          </div>
        </Form>
      ) : modal.kind === "token" ? (
        <>
          <Notice>令牌只显示一次，请立即保存。</Notice>
          <p className="code">sample-token-not-valid</p>
          <div className="form-actions">
            <Button
              onClick={() => {
                navigator.clipboard
                  ?.writeText("sample-token-not-valid")
                  .then(() => notify("已复制"))
                  .catch(() => notify("请手动选择并复制"));
              }}
            >
              复制令牌
            </Button>
            <Button kind="primary" onClick={close}>
              已保存
            </Button>
          </div>
        </>
      ) : modal.kind === "install" ? (
        <>
          <div className="install-target"><strong>{n?.name}</strong><span className="muted">接入标识 node-{n?.id}</span></div>
          <Field
            label="上报间隔（秒）"
            type="number"
            min="3"
            max="60"
            step="1"
            required
            value={reportInterval}
            onChange={e=>setReportInterval(e.target.value)}
            hint="3–60 秒，整数；默认 3 秒。"
          />
          <p
            className="muted small"
            style={{
              marginTop: 18,
            }}
          >
            在对应主机上运行安装命令，并输入原节点令牌。令牌丢失时可轮换后重新接入。
          </p>
          <pre className="code">
            {
              installCommand || "请先填写有效的上报间隔。"
            }
          </pre>
          <div className="form-actions">
            <Button
              kind="danger"
              onClick={() =>
                replace({
                  kind: "confirm",
                  title: "轮换令牌",
                  detail: "旧 Agent 将断开，更新令牌后才能重新连接。",
                  action: () => {
                    setTimeout(
                      () =>
                        replace({
                          kind: "token",
                        }),
                      0,
                    );
                  },
                })
              }
            >
              轮换令牌
            </Button>
            <Button disabled={!!reportError}
              onClick={() =>
                navigator.clipboard
                  .writeText(installCommand)
                  .then(() => notify("已复制"))
                  .catch(() => notify("请手动选择并复制"))
              }
            >
              复制命令
            </Button>
          </div>
        </>
      ) : modal.kind === "registration" ? (
        <>
          <Notice>
            {register ? "注册窗口已开启，剩余 14:59" : "注册窗口已关闭"}
          </Notice>
          <p className="muted small">
            窗口内可为多台主机注册节点。关闭后注册命令立即失效。
          </p>
          <pre className="code">
            {register
              ? "https://hub.example.invalid/install.sh\n--register-key sample-key-not-valid"
              : "—"}
          </pre>
          <div className="form-actions">
            <Button onClick={() => setRegister(!register)}>
              {register ? "关闭窗口" : "开启窗口"}
            </Button>
            <Button
              disabled={!register}
              onClick={() =>
                navigator.clipboard
                  .writeText("sample-registration-command-not-valid")
                  .then(() => notify("已复制"))
                  .catch(() => notify("请手动选择并复制"))
              }
            >
              复制注册命令
            </Button>
          </div>
        </>
      ) : modal.kind === "restore" ? (
        <Form onSubmit={restore} className="stack">
          <Notice error>恢复会覆盖现有数据并结束所有登录会话。</Notice>
          <Field
            label="备份文件"
            type="file"
            accept=".gz,.tgz"
            required
            disabled={busy}
          />
          <Check required disabled={busy}>
            我已保留当前数据的备份
          </Check>
          {progress !== null && (
            <div className="stack">
              <progress
                className="progress"
                max="100"
                value={progress}
                aria-label="恢复进度"
              ></progress>
              <span className="mono small">
                {progress === 100 ? "恢复完成" : `上传中 ${progress}%`}
              </span>
            </div>
          )}
          <div className="form-actions">
            <Button
              type="button"
              onClick={() => {
                clearInterval(timer.current);
                finish("已取消恢复");
              }}
            >
              取消
            </Button>
            <Button
              kind="danger"
              type="submit"
              disabled={busy || progress === 100}
            >
              {busy ? "恢复中…" : "确认恢复"}
            </Button>
          </div>
        </Form>
      ) : null}
    </Modal>
  );
}
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
