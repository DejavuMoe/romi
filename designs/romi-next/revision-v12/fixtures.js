window.romiFixtures = {
  nodes: [
    {
      id: 1,
      name: "东京 · edge-01",
      region: "日本 / JP",
      os: "Debian 12",
      arch: "x86_64",
      online: true,

      cpu: 24,
      mem: 42,
      disk: 31,
      rx: 12.4,
      tx: 3.8,
      traffic: 326,
      limit: 1000,
      uptime: "32 天 6 小时",
      ip: "192.0.2.11",
    },
    {
      id: 2,
      name: "新加坡 · core-02",
      region: "新加坡 / SG",
      os: "Alpine 3.22",
      arch: "aarch64",
      online: true,

      cpu: 61,
      mem: 68,
      disk: 46,
      rx: 8.2,
      tx: 5.1,
      traffic: 718,
      limit: 1000,
      uptime: "18 天 2 小时",
      ip: "192.0.2.12",
    },
    {
      id: 3,
      name: "香港 · relay-03",
      region: "中国香港 / HK",
      os: "Debian 13",
      arch: "x86_64",
      online: true,
      public: false,

      cpu: 13,
      mem: 29,
      disk: 22,
      rx: 4.6,
      tx: 2.3,
      traffic: 142,
      limit: 500,
      uptime: "46 天 11 小时",
      ip: "192.0.2.13",
    },
    {
      id: 4,
      name: "法兰克福 · eu-01",
      region: "德国 / DE",
      os: "Debian 12",
      arch: "aarch64",
      online: true,

      cpu: 8,
      mem: 36,
      disk: 54,
      rx: 1.8,
      tx: 0.7,
      traffic: 89,
      limit: 500,
      uptime: "9 天 15 小时",
      ip: "192.0.2.14",
    },
    {
      id: 5,
      name: "洛杉矶 · west-01",
      region: "美国 / US",
      os: "Alpine 3.22",
      arch: "x86_64",
      online: false,

      cpu: 0,
      mem: 0,
      disk: 40,
      rx: 0,
      tx: 0,
      traffic: 204,
      limit: 1000,
      uptime: "12 分钟前",
      ip: "192.0.2.15",
    },
    {
      id: 6,
      name: "备用 · standby",
      region: "—",
      os: "—",
      arch: "—",
      online: false,

      cpu: 0,
      mem: 0,
      disk: 0,
      rx: 0,
      tx: 0,
      traffic: 0,
      limit: 500,
      uptime: "尚未连接",
      ip: "—",
    },
  ],
  probes: [
    {
      id: 1,
      name: "主站 HTTPS",
      target: "status.example.invalid:443",
      interval: 60,
      nodes: [1, 2, 3, 4],
    },
    {
      id: 2,
      name: "备用入口",
      target: "backup.example.invalid:443",
      interval: 30,
      nodes: [1, 3],
    },
  ],
  nav: [
    ["nodes", "节点", "01"],
    ["probes", "监测", "02"],
    ["notifications", "通知", "03"],
    ["data", "数据", "04"],
    ["security", "安全", "05"],
    ["settings", "设置", "06"],
  ],
  series: Array.from(
    {
      length: 48,
    },
    (_, i) =>
      Math.round(
        27 +
          Math.sin(i * 0.46) * 11 +
          Math.cos(i * 1.7) * 4 +
          (i > 28 && i < 35 ? 22 : 0),
      ),
  ),
};

romiFixtures.nodes = romiFixtures.nodes.map((n, i) => ({ ...n, priority: (6-i)*10, hasIPv4: i !== 5, hasIPv6: i < 4, totalUp: n.traffic * 0.4, totalDown: n.traffic * 0.6 }));

romiFixtures.now = Date.UTC(2026,8,22);
romiFixtures.nodes = romiFixtures.nodes.map((n,i)=>({
  ...n, price:[5,8,12,36,4,0][i], currency:"USD", cycle:i===3?"年付":"月付",
  expires:i===3?"2027-09-22":i===4?"2026-09-20":i===5?"":"2026-10-21",
  kernel:i%2?"6.12.43-0-lts":"6.12.43-amd64", cpuName:i%2?"AMD EPYC 7B12":"Intel Xeon E5-2680 v4",
  cores:i===1?4:2, memGiB:i===1?8:4, diskGiB:i===1?160:80,
  downloadMbps:i===2?2500:1000, uploadMbps:i===2?500:1000,
  totalUp:[840,1120,480,160,92,0][i], totalDown:[1680,2240,960,320,184,0][i],
  continuity:n.uptime, uptime:i===0?"2 小时 16 分":n.uptime,
  online:i===2?false:n.online, gapMinutes:i===2?2:i===4?12:0,
}));
window.romiView = {
  bandwidth: value => value==null?"未设置":value>=1000?`${value/1000} Gbps`:`${value} Mbps`,
  volume: value => value>=1024?`${(value/1024).toFixed(2)} TiB`:`${Number(value).toFixed(1)} GiB`,
  remaining: (date,now=romiFixtures.now) => { if(!date)return "长期有效";const days=Math.ceil((Date.parse(date+"T00:00:00Z")-now)/86400000);return days>0?`剩余 ${days} 天`:days===0?"今日到期":`已过期 ${-days} 天`; },
  continuity: (node,grace=5) => node.uptime==="尚未连接"?"尚未接入":node.online?node.continuity:node.gapMinutes<=grace?"等待恢复":"已中断",
  status: (node,grace=5) => node.online?"在线":node.uptime==="尚未连接"?"未连接":node.gapMinutes<=grace?"重连中":"离线",
};

romiView.numericError=(raw,{min=0,max=Infinity,step=1,required=false}={})=>{
  if(raw==="")return required?"请填写此项":"";
  const integer=String(step)==="1";
  if(!(integer?/^\d+$/:/^(?:\d+(?:\.\d*)?|\.\d+)$/).test(String(raw)))return integer?"请输入非负整数":"请输入非负数";
  const n=Number(raw);
  if(!Number.isFinite(n))return "数值过大";
  if(n<Number(min))return `不能小于 ${min}`;
  if(n>Number(max))return `不能大于 ${max}`;
  if(step!=="any"&&Math.abs((n-Number(min))/Number(step)-Math.round((n-Number(min))/Number(step)))>1e-7)return `请按 ${step} 的步长填写`;
  return "";
};
romiView.dateError=raw=>!raw?"":!/^\d{4}-\d{2}-\d{2}$/.test(raw)||!Number.isFinite(Date.parse(raw+"T00:00:00Z"))||new Date(raw+"T00:00:00Z").toISOString().slice(0,10)!==raw?"请输入有效日期":"";

Object.assign(romiFixtures.nodes[5],{kernel:"—",cpuName:"",cores:null,memGiB:null,diskGiB:null});

romiFixtures.nodes=romiFixtures.nodes.map((n,i)=>({...n,
  cpu:i===3?91:n.cpu,mem:i===3?87:n.mem,disk:i===3?92:n.disk,
  procs:i===5?null:110+i*17,tcp:i===5?null:180+i*25,udp:i===5?null:18+i*4,
  zramGiB:i===5?null:i===1?0.32:i===2?0.18:0,
  swapfileGiB:i===5?null:i===1?0.45:i===0?0.2:0,
  swapPartitionGiB:i===5?null:i===1?0.12:i===4?0.3:0,
  zramEnabled:i===5?null:i===1||i===2,swapEnabled:i===5?null:i===0||i===1||i===4,
}));
romiView.level=value=>typeof value!=="number"||!Number.isFinite(value)||value<0||value>100?"unknown":value>=85?"critical":value>=60?"warning":"normal";
romiView.segments=values=>{const groups=[];let group=[];values.forEach((value,index)=>{if(value==null){if(group.length)groups.push(group);group=[];}else group.push([index,value]);});if(group.length)groups.push(group);return groups;};
romiView.series=(value,scale=1)=>value==null?[]:Array.from({length:48},(_,i)=>Math.max(0,value+(Math.sin(i*.43)-Math.sin(47*.43))*scale));
romiView.swapDisk=node=>node.swapEnabled===null?null:(node.swapfileGiB||0)+(node.swapPartitionGiB||0);
romiView.plots=(node,tab)=>{
 const known=node.uptime!=="尚未连接";
 const series=(label,key,value,scale=1,status="ready")=>({label,key,value,values:known&&status==="ready"?romiView.series(value,scale).map(v=>["process","tcp","udp"].includes(key)?Math.round(v):["cpu","disk"].includes(key)?Math.min(100,v):v):[],status:known?status:"unknown"});
 const memoryStatus=flag=>flag===null?"unknown":flag?"ready":"disabled";
 const network={name:"上传 / 下载",unit:"MiB/s",series:[series("上传","upload",node.tx,1),series("下载","download",node.rx,1.4)]};
 if(tab==="监测")return [{name:"主站 HTTPS",unit:"ms",series:[series("延迟","cpu",42,9)]},{name:"备用入口",unit:"ms",series:[series("延迟","cpu",68,12)]}];
 if(tab==="流量")return [network];
 return [
  {name:"CPU",unit:"%",max:100,usage:node.online?node.cpu:null,series:[series("CPU","cpu",node.cpu,8)]},
  {name:"RAM",unit:"GiB",max:node.memGiB||1,usage:node.online?node.mem:null,series:[series("RAM","ram",node.memGiB==null?null:node.memGiB*node.mem/100,.3),series("ZRAM","zram",node.zramGiB,.04,memoryStatus(node.zramEnabled)),series("Swap","swap",romiView.swapDisk(node),.04,memoryStatus(node.swapEnabled))],swapSources:true},
  {name:"磁盘",unit:"%",max:100,usage:node.online?node.disk:null,series:[series("磁盘用量","disk",node.disk,2)]},
  {name:"进程数",unit:"个",series:[series("进程","process",node.procs,14)]},network,
  {name:"TCP / UDP 连接",unit:"个",series:[series("TCP","tcp",node.tcp,22),series("UDP","udp",node.udp,4)]},
 ];
};

romiFixtures.nodes=romiFixtures.nodes.map((n,i)=>({...n,swapfileEnabled:i===5?null:i===0||i===1,swapPartitionEnabled:i===5?null:i===1||i===4}));

romiFixtures.nodes=romiFixtures.nodes.map((n,i)=>({...n,ipv6:i<4?`2001:db8::${11+i}`:null,agentVersion:i===5?null:"0.0.1"}));
