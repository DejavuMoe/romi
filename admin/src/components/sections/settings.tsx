import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { bytes } from "@/lib/format"

import { LoadState, useSettings } from "./common"

type GeoStatus = {state:string;received:number;error:string;configured:boolean}
function GeoSettings({url,setUrl}:{url:string;setUrl:(url:string)=>void}) {
  const [status,setStatus]=useState<GeoStatus|null>(null),[error,setError]=useState("")
  const [readError,setReadError]=useState("")
  const [busy,setBusy]=useState(false)
  useEffect(()=>{let cancelled=false;let timer:ReturnType<typeof setTimeout>;const load=()=>api<GeoStatus>("/geolite").then(v=>{if(!cancelled){setStatus(v);setReadError("");timer=setTimeout(load,v.state==="downloading"?500:3000)}}).catch(e=>{if(!cancelled){setReadError(e.message);timer=setTimeout(load,3000)}});void load();return()=>{cancelled=true;clearTimeout(timer)}},[])
  const update=async()=>{setBusy(true);setError("");try {await api("/settings",{method:"PUT",body:JSON.stringify({geolite_url:url})});await api("/geolite",{method:"POST"});setStatus({state:"downloading",received:0,error:"",configured:!!status?.configured})}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Card><h2 className="text-sm font-medium">GeoLite2 Country</h2><Field label="HTTPS 数据库直链"><Input value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://example.com/GeoLite2-Country.mmdb"/></Field>
    <div><p className="text-xs text-muted-foreground">{status ? status.configured?"已配置本地数据库":"未配置" : "正在读取状态"}{status?.state==="downloading"?` · 已下载 ${bytes(status.received)}`:status?.state==="complete"?" · 更新完成":status?.state==="cancelled"?" · 已取消":""}</p>
    <p role="alert" className="field-error">{error || readError || (status?.state==="cancelled" ? "" : status?.error)}</p></div><div className="flex gap-2"><Button disabled={busy || status?.state==="downloading" || !url.trim()} onClick={update}>{status?.state==="error"?"重试":"下载并更新"}</Button>{status?.state==="downloading"&&<Button variant="outline" onClick={()=>{setError("");void api("/geolite",{method:"DELETE"}).catch(e=>setError(e.message))}}>取消</Button>}</div></Card>
}
export function SettingsTab() {
  const {s,set,save,error,retry}=useSettings()
  if(!s)return <LoadState error={error} retry={retry}/>
  return <div className="space-y-4">{error && <p role="alert" className="field-error">{error}</p>}<Card><h2 className="text-sm font-medium">站点</h2><Field label="站点名称"><Input value={String(s.site_name??"")} onChange={e=>set("site_name",e.target.value)}/></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="分钟历史保留天数" hint="1–3650；小时历史保留一年"><Input type="number" min={1} max={3650} step={1} value={String(s.retention_days??"30")} onChange={e=>set("retention_days",e.target.value)}/></Field>
    <Field label="连续在线重置阈值（分钟）" hint="1–60；中断超过此时长后重新计时"><Input type="number" min={1} max={60} step={1} value={String(s.online_grace_minutes??"5")} onChange={e=>set("online_grace_minutes",e.target.value)}/></Field></div>
    <Field label="公开页默认视图"><Select value={String(s.public_default_view || "cards")} onValueChange={v=>set("public_default_view",v)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="cards">卡片</SelectItem><SelectItem value="list">列表</SelectItem></SelectContent></Select></Field>
    <label className="choice-row"><Switch checked={s.public_page==="on"} onCheckedChange={v=>set("public_page",v?"on":"off")}/>开放公开状态页，关闭后所有页面需登录</label>
    <Button onClick={()=>save({site_name:String(s.site_name??""),retention_days:String(s.retention_days||"30"),online_grace_minutes:String(s.online_grace_minutes||"5"),public_page:s.public_page==="on"?"on":"off",public_default_view:String(s.public_default_view||"cards")})}>保存站点设置</Button></Card>
    <GeoSettings url={String(s.geolite_url??"")} setUrl={v=>set("geolite_url",v)}/></div>
}
