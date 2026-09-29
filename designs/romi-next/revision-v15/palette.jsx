// Search and jump: nodes, pages and actions from one field (/ or ⌘K).

function scoreItem(item, q) {
  if (!q) return 1
  const hay = [item.label, item.hint, ...(item.keywords || [])].join(" ").toLowerCase()
  const at = hay.indexOf(q)
  if (at === 0) return 3
  if (at > 0) return 2
  // Letters in order, for "tky" → "tokyo"-style fragments.
  let k = 0
  for (const ch of hay) if (ch === q[k]) k++
  return k === q.length ? 1 : 0
}

function Palette({ items, onClose, placeholder = T("搜索节点") }) {
  const panel = useRef(null)
  const list = useRef(null)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  useOverlay(true, onClose, panel)
  const q = query.trim().toLowerCase()
  const results = items
    .map((it) => ({ it, s: scoreItem(it, q) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.it)
  const groups = []
  results.forEach((it) => {
    let g = groups.find((x) => x.name === it.group)
    if (!g) groups.push((g = { name: it.group, items: [] }))
    g.items.push(it)
  })
  const flat = groups.flatMap((g) => g.items)
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  const run = (it) => {
    onClose()
    setTimeout(() => it.run(), 0)
  }
  return ReactDOM.createPortal(
    <div className="overlay overlay-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="dialog dialog-palette palette" role="dialog" aria-modal="true" aria-label={T("搜索")} tabIndex={-1}>
        <div className="palette-input">
          <Icon name="search" size={20} />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={flat[active] ? `palette-${flat[active].id}` : undefined}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(flat.length - 1, active + 1)) }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)) }
              if (e.key === "Enter" && flat[active]) { e.preventDefault(); run(flat[active]) }
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list} aria-label={T("搜索结果")}>
          {!flat.length && <p className="palette-empty">{T("没有匹配的结果")}</p>}
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name} className="palette-group">
              <p className="palette-group-name" aria-hidden="true">{g.name}</p>
              {g.items.map((it) => {
                const index = flat.indexOf(it)
                return (
                  <div
                    key={it.id}
                    id={`palette-${it.id}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    className="palette-item"
                    onMouseMove={() => setActive(index)}
                    onClick={() => run(it)}
                  >
                    <span className="palette-icon">{it.node ? <StatusDot status={fmt.connection(it.node)} /> : <Icon name={it.icon || "arrow-up-right"} />}</span>
                    <span className="palette-label">{it.label}</span>
                    {it.hint && <span className="palette-hint">{it.hint}</span>}
                    <Icon name="chevron-right" size={14} className="palette-go" />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd>{T("选择")}</span>
          <span><Kbd>↵</Kbd>{T("打开")}</span>
          <span><Kbd>esc</Kbd>{T("关闭")}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Node entries for the palette.
function nodeItems(nodes, open) {
  return nodes.map((n) => {
    const f = nodeFacts(n)
    return {
      id: `node-${n.id}`,
      group: T("节点"),
      node: n,
      label: n.name,
      hint: [window.romiGeo.countryName(n.country), fmt.connectionLabel(n), f.cpu != null ? `CPU ${f.cpu.toFixed(0)}%` : ""].filter(Boolean).join(" · "),
      keywords: [n.country, n.os, n.ipv4, n.ipv6, `node-${n.id}`].filter(Boolean),
      run: () => open(n),
    }
  })
}

Object.assign(window, { Palette, nodeItems })
