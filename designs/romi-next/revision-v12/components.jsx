const { useEffect, useRef, useState } = React;
function Button({ children, kind = "", className = "", ...props }) {
  return (
    <button className={`btn ${kind} ${className}`} {...props}>
      {children}
    </button>
  );
}
function ViewSwitch({view,onChange}) {
  return <div className="segments view-switch" aria-label="显示方式">{[["list","列表"],["cards","卡片"]].map(([value,label])=><button key={value} aria-pressed={view===value} onClick={()=>onChange(value)}>{label}</button>)}</div>;
}
function RatePair({node}) {
  return node.online?<span className="rate-pair"><span>{node.tx.toFixed(1)} MiB/s</span>{" / "}<span>{node.rx.toFixed(1)} MiB/s</span></span>:<span className="muted">—</span>;
}
function CopyValue({value,label,onCopy}) {
  return value?<button className="copy-value" aria-label={`复制 ${label}`} onClick={()=>navigator.clipboard.writeText(value).then(()=>onCopy("已复制")).catch(()=>onCopy("复制失败，请选择文本复制"))}><span>{value}</span><svg className="copy-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4V16H8"/></svg></button>:<span className="missing-value">未上报</span>;
}
function Status({ node, grace=5 }) {
  return (
    <span className={`pill ${node.online ? "good" : "offline"}`}>
      <i className="dot" aria-hidden="true"></i>
      {romiView.status(node,grace)}
    </span>
  );
}
function UsageValue({value}) {
  const level=romiView.level(value),labels={normal:"正常",warning:"偏高",critical:"高用量",unknown:"未上报"};
  return <span className="usage-value" data-tone={level} aria-label={level==="unknown"?"未上报":`${value}% · ${labels[level]}`}>{level==="unknown"?"—":value+"%"}</span>;
}
function Meter({value,label}) {
  const level=romiView.level(value);
  return <div className="meter" data-tone={level}>{label?<div className="resource-heading"><span>{label}</span><UsageValue value={value}/></div>:<UsageValue value={value}/>}<div className="track" aria-hidden="true"><i style={{width:level==="unknown"?"0":value+"%"}}/></div></div>;
}
function validateInput(input) {
  if(input.dataset.valueType==="number") input.setCustomValidity(romiView.numericError(input.value,{min:input.getAttribute("min")??0,max:input.getAttribute("max")??Infinity,step:input.getAttribute("step")??1,required:input.required}));
  if(input.dataset.valueType==="date") input.setCustomValidity(romiView.dateError(input.value));
}
function Form({ onSubmit, children, ...props }) {
  return <form {...props} noValidate onSubmit={e=>{e.preventDefault();e.currentTarget.querySelectorAll("[data-value-type]").forEach(validateInput);if(!e.currentTarget.checkValidity()){e.currentTarget.querySelector(":invalid")?.focus();return;}onSubmit?.(e);}}>{children}</form>;
}
// `error` is a refusal the field cannot discover for itself -- one the hub
// returns, such as a rejected current password. It renders in the same slot and
// with the same wiring as a validation error, so the message stays attached to
// the input it concerns instead of floating between two fields.
function Field({ label, hint, error: refusal, children, wide, ...props }) {
  const id=React.useId(),[error,setError]=useState(""),[touched,setTouched]=useState(false);
  const message=input=>input.validity.valueMissing?"请填写此项":input.validity.typeMismatch?"请输入有效地址":input.validity.patternMismatch?"请检查输入格式":input.validationMessage;
  const invalid=e=>{e.preventDefault();setTouched(true);setError(message(e.currentTarget));};
  const shown=refusal||error;
  const described=shown?id+"-error":hint?id+"-hint":undefined;
  return <label htmlFor={id} className={`field ${wide?"full":""}`}><span>{label}</span>
    {children?React.cloneElement(children,{id,"aria-label":children.props["aria-label"]||label,"aria-describedby":described,onInvalid:invalid}):<input {...props} id={id}
      type={["number","date"].includes(props.type)?"text":props.type}
      data-value-type={["number","date"].includes(props.type)?props.type:undefined}
      inputMode={props.type==="number"?(props.step==="any"||props.step==="0.01"?"decimal":"numeric"):props.type==="date"?"numeric":props.inputMode}
      placeholder={props.type==="date"?"YYYY-MM-DD":props.placeholder}
      aria-label={label} aria-invalid={!!shown} aria-describedby={described} onInvalid={invalid}
      onBlur={e=>{validateInput(e.currentTarget);setTouched(true);setError(e.currentTarget.validity.valid?"":message(e.currentTarget));props.onBlur?.(e);}}
      onInput={e=>{props.onInput?.(e);validateInput(e.currentTarget);if(touched)setError(e.currentTarget.validity.valid?"":message(e.currentTarget));}}/>}
    <span className={`field-feedback ${hint?"with-hint":""}`}>{shown?<span id={id+"-error"} className="field-error" role="alert">{shown}</span>:hint?<span id={id+"-hint"} className="hint">{hint}</span>:null}</span>
  </label>;
}
function Select({ children, value, defaultValue, onChange, name, disabled, ...props }) {
  const options=React.Children.toArray(children).map(item=>({value:String(item.props.value??React.Children.toArray(item.props.children).join("")),label:React.Children.toArray(item.props.children).join("")}));
  const [local,setLocal]=useState(String(defaultValue??options[0]?.value??"")),[open,setOpen]=useState(false),[active,setActive]=useState(0),[above,setAbove]=useState(false);
  const selected=String(value??local),root=useRef(null),button=useRef(null),list=React.useId();
  useEffect(()=>{if(open)document.getElementById(`${list}-${active}`)?.scrollIntoView({block:"nearest"});},[open,active,list]);
  useEffect(()=>{const close=e=>{if(!root.current?.contains(e.target))setOpen(false);};document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close);},[]);
  const expand=()=>{const r=button.current.getBoundingClientRect();setAbove(innerHeight-r.bottom<Math.min(options.length*36,240)&&r.top>innerHeight-r.bottom);setActive(Math.max(0,options.findIndex(o=>o.value===selected)));setOpen(true);};
  const choose=index=>{const next=options[index].value;setLocal(next);onChange?.({target:{value:next},currentTarget:{value:next}});setOpen(false);button.current.focus();};
  return <span className="select-control" ref={root}>
    {name&&<input type="hidden" name={name} value={selected} disabled={disabled}/>}
    <button {...props} type="button" ref={button} role="combobox" className="select-trigger" disabled={disabled} aria-expanded={open} aria-haspopup="listbox" aria-controls={list} aria-activedescendant={open?`${list}-${active}`:undefined}
      onClick={e=>{e.preventDefault();open?setOpen(false):expand();}}
      onKeyDown={e=>{if(e.key==="Tab"){setOpen(false);return;}if(e.key==="Escape"&&open){e.preventDefault();e.stopPropagation();setOpen(false);return;}if(["ArrowDown","ArrowUp","Home","End","Enter"," "].includes(e.key)){e.preventDefault();if(!open){expand();return;}if(e.key==="Enter"||e.key===" "){choose(active);return;}setActive(e.key==="Home"?0:e.key==="End"?options.length-1:Math.max(0,Math.min(options.length-1,active+(e.key==="ArrowDown"?1:-1))));}}}>
      {options.find(o=>o.value===selected)?.label}<span className="select-chevron" aria-hidden="true"></span>
    </button>
    {open&&<span id={list} role="listbox" className={`select-options ${above?"above":""}`} aria-label={props["aria-label"]}>
      {options.map((option,index)=><span key={option.value} id={`${list}-${index}`} role="option" aria-selected={selected===option.value} className={active===index?"highlighted":""} onPointerDown={e=>e.preventDefault()} onClick={e=>{e.preventDefault();choose(index);}}>{option.label}</span>)}
    </span>}
  </span>;
}
function Check({ children, ...props }) {
  const [error,setError]=useState(false);
  return (
    <label className="check">
      <input type="checkbox" {...props} onInvalid={e=>{e.preventDefault();setError(true);}} onChange={e=>{setError(false);props.onChange?.(e);}} />
      <span>{children}</span>
      {props.required&&<span className="check-feedback field-error" role={error?"alert":undefined}>{error?"请确认此项":""}</span>}
    </label>
  );
}
function Modal({ title, onClose, children, className = "", id }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow=document.documentElement.style.overflow;
    document.documentElement.style.overflow="hidden";
    ref.current.showModal();
    return () => {
      document.documentElement.style.overflow=overflow;
      if (previous?.isConnected) previous.focus({preventScroll:true});
    };
  }, []);
  return (
    <dialog
      className={className}
      id={id}
      ref={ref}
      aria-labelledby="dialog-title"
      onKeyDown={e => {
        if (e.key !== "Tab") return;
        const controls = [...ref.current.querySelectorAll("button, input, select, textarea, a[href]")].filter(el => !el.disabled && el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if ((e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <Button kind="quiet icon" aria-label="关闭" onClick={onClose}>
          ×
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
function Chart({name="CPU",offset=0,mini=false,series,max=100}) {
  const lines=series||[{key:"cpu",label:name,values:romiFixtures.series.map(v=>v+offset)}];
  return <svg className={mini?"mini-chart":"chart"} viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-label={`${name} 趋势：${lines.filter(s=>s.values.length).map(s=>s.label).join("、")}`}>
    {!mini&&[10,85,160].map(y=><line key={y} className="chart-grid" x1="0" x2="600" y1={y} y2={y}/>)}
    {lines.map((line,index)=>romiView.segments(line.values).map((group,part)=><polyline key={line.key+part} points={group.map(([i,v])=>`${i*600/47},${160-Math.min(max,v)/max*150}`).join(" ")} fill="none" stroke={`var(--series-${line.key})`} strokeWidth="2" strokeDasharray={index===1?"7 4":index===2?"2 4":undefined} vectorEffect="non-scaling-stroke"/>))}
  </svg>;
}
function ResourceChart({plot,node,hours}) {
  const values=plot.series.flatMap(s=>s.values).filter(Number.isFinite),max=plot.max||Math.max(1,Math.ceil(Math.max(0,...values)/10)*10);
  const format=v=>plot.unit==="个"||plot.unit==="%"?String(Math.round(v)):Number(v.toFixed(2)).toString();
  const axes={"1 小时":["-60 分","-30 分","现在"],"6 小时":["-6 小时","-3 小时","现在"],"24 小时":["-24 小时","-12 小时","现在"],"7 天":["-7 天","-3 天","现在"],"30 天":["-30 天","-15 天","现在"],"1 年":["-1 年","-6 月","现在"]};
  return <article className="box resource-chart" aria-label={plot.name+"图表"}>
    <div className="box-head"><div className="chart-title"><h2>{plot.name}</h2>{Object.hasOwn(plot,"usage")&&<UsageValue value={plot.usage}/>}</div><span className="muted small">{hours}</span></div>
    <div className="plot-unit">{plot.unit}</div>
    <div className="plot-area"><div className="plot-y" aria-hidden="true"><span>{values.length?format(max):"—"}</span><span>{values.length?format(max/2):"—"}</span><span>{values.length?"0":"—"}</span></div>
      {values.length?<Chart name={plot.name} series={plot.series} max={max}/>:<div className="plot-empty">暂无历史数据</div>}
    </div><div className="chart-axis">{(axes[hours]||axes["24 小时"]).map(label=><span key={label}>{label}</span>)}</div>
    <ul className="series-legend">{plot.series.map((s,index)=><li key={s.key}><span className="series-name"><i style={{borderColor:`var(--series-${s.key})`,borderTopStyle:index===1?"dashed":index===2?"dotted":"solid"}}/>{s.label}</span><span>{s.status==="disabled"?"未启用":s.status==="unknown"?"未上报":node.online?format(s.value)+" "+plot.unit:"—"}</span></li>)}</ul>
    {plot.swapSources&&<div className="swap-sources"><span>Swapfile {node.swapfileEnabled===null?"未上报":node.swapfileEnabled?`${node.swapfileGiB||0} GiB`:"未启用"}</span><span>分区 {node.swapPartitionEnabled===null?"未上报":node.swapPartitionEnabled?`${node.swapPartitionGiB||0} GiB`:"未启用"}</span></div>}
  </article>;
}
function Empty({
  title = "暂无数据",
  detail,
  action,
  onAction,
  error = false,
}) {
  return (
    <div className="empty" role={error ? "alert" : "status"}>
      <span className={`mono ${error ? "danger" : "muted"}`} aria-hidden="true">
        {error ? "[ ! ]" : "[ — ]"}
      </span>
      <h2>{title}</h2>
      <p>{detail || (error ? "请稍后重试。" : "数据到达后会显示在这里。")}</p>
      {action && <Button onClick={onAction}>{action}</Button>}
    </div>
  );
}
function KPIs({ nodes }) {
  const online = nodes.filter(n => n.online);
  const rate = key => online.reduce((sum,n) => sum + n[key],0).toFixed(1);
  const total = key => (nodes.reduce((sum,n) => sum + (n[key] || 0),0)/1024).toFixed(2);
  return <section className="kpis summary-kpis" aria-label="节点汇总">
    <div className="kpi"><div className="label">服务器总数</div><strong>{nodes.length}</strong></div>
    <div className="kpi"><div className="label">在线服务器</div><strong className="online-count">{online.length}</strong></div>
    <div className="kpi"><div className="label">离线服务器</div><strong className="offline-count">{nodes.length-online.length}</strong></div>
    <div className="kpi network-kpi"><div className="label">网络</div><table className="network-summary" aria-label="网络汇总"><thead><tr><th scope="col" aria-label="指标"></th><th scope="col">上传</th><th scope="col">下载</th></tr></thead><tbody><tr><th scope="row">实时速率</th><td>{rate("tx")} MiB/s</td><td>{rate("rx")} MiB/s</td></tr><tr><th scope="row">累计流量</th><td>{total("totalUp")} TiB</td><td>{total("totalDown")} TiB</td></tr></tbody></table></div>
  </section>;
}
function Notice({ children, error = false }) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
Object.assign(window, {
  Button,
  Status,
  Meter,
  UsageValue,
  ResourceChart,
  Field,
  Form,
  Select,
  Check,
  Modal,
  Chart,
  Empty,
  KPIs,
  Notice,
});
