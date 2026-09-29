// The v14 visual system, rendered from the product's own components in both
// themes side by side. Values only: every name here is a token, a size or copy
// the product already uses.
const specParams = new URLSearchParams(location.search);
if (specParams.get("font") === "sans") document.documentElement.dataset.font = "sans";

const SPEC_COLORS = {
  light: [
    ["--background", "#fffcf0"], ["--foreground", "#100f0f"], ["--secondary", "#f2efe4"],
    ["--muted", "#e6e4d9"], ["--muted-foreground", "#6f6e69"], ["--border", "#b7b5ac"],
    ["--input", "#878580"], ["--primary", "#205ea6"], ["--ok", "#237a50"],
    ["--warn", "#8d6500"], ["--destructive", "#af3029"],
  ],
  dark: [
    ["--background", "#14171c"], ["--foreground", "#e6e8ec"], ["--secondary", "#1d2229"],
    ["--muted", "#28313c"], ["--muted-foreground", "#aeb7c2"], ["--border", "#39424d"],
    ["--input", "#64708a"], ["--primary", "#99b9dd"], ["--ok", "#83c9a2"],
    ["--warn", "#e6c06b"], ["--destructive", "#f07970"],
  ],
};
const SPEC_SIZES = [["--text-xs", 11], ["--text-sm", 12], ["--text-md", 13], ["--text-lg", 15], ["--text-xl", 20], ["--text-2xl", 24]];
const SPEC_SPACES = [["--space-1", 4], ["--space-2", 8], ["--space-3", 12], ["--space-4", 16], ["--space-5", 24], ["--space-6", 32]];

function SpecSection({ title, children }) {
  return (
    <section className="spec-section">
      <h2>{title}</h2>
      <div className="spec-body">{children}</div>
    </section>
  );
}

function SpecPane({ theme }) {
  const nodes = romiFixtures.nodes;
  const [view, setView] = React.useState("cards");
  const [tab, setTab] = React.useState("资源");
  return (
    <div className="spec-pane" data-theme={theme}>
      <h1>{theme === "dark" ? "暗色" : "亮色"}</h1>

      <SpecSection title="颜色">
        <ul className="spec-swatches">
          {SPEC_COLORS[theme].map(([name, value]) => (
            <li key={name}>
              <span className="spec-chip" style={{ background: `var(${name})` }}></span>
              <code>{name}</code>
              <span className="mono muted">{value}</span>
            </li>
          ))}
        </ul>
      </SpecSection>

      <SpecSection title="字体">
        <dl className="spec-rows">
          <div>
            <dt><code>--font-ui</code></dt>
            <dd className="spec-face-ui">节点管理 · 添加节点 · 实时连接</dd>
          </div>
          <div>
            <dt><code>--font-mono</code></dt>
            <dd className="mono">192.0.2.11 · 2001:db8::11 · 24% · 1.7 / 4 GiB</dd>
          </div>
        </dl>
      </SpecSection>

      <SpecSection title="字号">
        <dl className="spec-rows">
          {SPEC_SIZES.map(([name, size]) => (
            <div key={name}>
              <dt><code>{name}</code> <span className="mono muted">{size}px</span></dt>
              <dd style={{ fontSize: size }}>东京 · edge-01 <span className="mono">24%</span></dd>
            </div>
          ))}
        </dl>
      </SpecSection>

      <SpecSection title="间距">
        <dl className="spec-rows">
          {SPEC_SPACES.map(([name, size]) => (
            <div key={name}>
              <dt><code>{name}</code> <span className="mono muted">{size}px</span></dt>
              <dd><span className="spec-space" style={{ width: size }}></span></dd>
            </div>
          ))}
        </dl>
      </SpecSection>

      <SpecSection title="线条">
        <KPIs nodes={nodes} />
      </SpecSection>

      <SpecSection title="状态">
        <div className="spec-inline">
          {[nodes[0], nodes[2], nodes[4], nodes[5]].map((n) => <Status key={n.id} node={n} />)}
        </div>
        <div className="spec-meters">
          <Meter label="CPU" value={24} />
          <Meter label="RAM" value={68} />
          <Meter label="磁盘" value={92} />
          <Meter label="CPU" value={null} />
        </div>
      </SpecSection>

      <SpecSection title="控件">
        <div className="spec-inline">
          <Button kind="primary">保存</Button>
          <Button>取消</Button>
          <Button kind="danger">删除节点</Button>
          <Button kind="quiet">编辑</Button>
          <Button disabled>保存</Button>
          <Button className="spec-focus">保存</Button>
        </div>
        <div className="spec-inline">
          <div className="segments" aria-label="显示方式">
            {[["list", "列表"], ["cards", "卡片"]].map(([value, label]) => (
              <button key={value} aria-pressed={view === value} onClick={() => setView(value)}>{label}</button>
            ))}
          </div>
          <div className="tabs" role="tablist" aria-label="历史类型">
            {["资源", "监测", "流量"].map((v) => (
              <button key={v} role="tab" aria-selected={tab === v} tabIndex={tab === v ? 0 : -1} onClick={() => setTab(v)}>{v}</button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <Field label="名称" defaultValue="东京 · edge-01" />
          <Field label="间隔（秒）" type="number" min="5" max="3600" defaultValue="60" hint="5–3600" />
          <Field label="目标地址" error="请填写此项" />
          <Field label="公开状态页">
            <Select defaultValue="public">
              <option value="public">显示</option>
              <option value="private">不显示</option>
            </Select>
          </Field>
        </div>
        <div className="choice-list choice-columns">
          <Check defaultChecked>东京 · edge-01</Check>
          <Check>新加坡 · core-02</Check>
        </div>
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="搜索节点" placeholder="搜索名称、IP 或节点标识" />
        </label>
      </SpecSection>

      <SpecSection title="空 / 错误 / 加载">
        <Empty title="还没有节点" action="添加节点" onAction={() => {}} />
        <Empty error title="节点加载失败" action="重试" onAction={() => {}} />
        <Notice>连接已断开，正在重连。</Notice>
        <div className="skeleton spec-skeleton" role="status" aria-label="正在加载"></div>
      </SpecSection>
    </div>
  );
}

function Spec() {
  return (
    <main className="spec" data-screen-id="system" data-screen-label="设计规范">
      <SpecPane theme="light" />
      <SpecPane theme="dark" />
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Spec />);
