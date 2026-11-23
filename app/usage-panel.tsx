import { useEffect, useState } from "react";
import { api } from "./studio-data";

const names = {design:"生图 / 改图", photo:"照片试穿",video:"短视频",live:"实时试穿",adjust:"余额调整"};
const labels = {charged:"已入账",refunded:"已返还",submitted:"任务已提交",reserved:"已预扣"};
type Rate = Exclude<keyof typeof names,"adjust">;
type Prices = Record<Rate,number>;
type User = {id:string; username:string; role:string; balance:number};
type Entry = {id:string;username:string;service:keyof typeof names;units:number;points:number;status:keyof typeof labels;created:number;observed:number|null;actor:string|null};
type Usage = {balance:number;prices:Prices|null;logs:Entry[]};
export function UsagePanel({management}:{management:boolean}) {
  const [data,setData]=useState<Usage>();
  const [users,setUsers]=useState<User[]>([]);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [offset,setOffset]=useState(0);
  const [revision,refresh]=useState(0);
  useEffect(()=>{
    let active=true;
    setData(undefined);
    Promise.all([api<Usage>("usage?offset="+offset), management ? api<{users:User[]}>("admin/users") : Promise.resolve({users:[]})])
      .then(([usage,list])=>{if(active){setData(usage);setUsers(list.users);}})
      .catch(e=>{if(active)setMessage(e.message);});
    return ()=>{active=false;};
  },[offset,revision,management]);
  async function save(path:string,body:unknown){
    setBusy(true);
    try{await api(path,body);setMessage("已保存");refresh(v=>v+1);}
    catch(e){setMessage((e as Error).message);}
    finally{setBusy(false);}
  }
  return <section className="panel billing-panel">
    <h1>{management?"用户与计费设置":"使用日志"}</h1>
    {message && <p role="status">{message}</p>}
    {data && <>
      <p>我的可用余额 · {data.balance} 积分</p>
      {management && <>
        <h2>计费设置</h2>
        <form onSubmit={e=>{e.preventDefault();const values=new FormData(e.currentTarget);void save("admin/prices",Object.fromEntries([...values].map(([k,v])=>[k,Number(v)])));}}>
          {(["design","photo","video","live"] as Rate[]).map(k=><label key={k}>{names[k]}（积分/{k==="live"?"授权秒":"次"}）
            <input name={k} type="number" required min="0" max="1000000" defaultValue={data.prices?.[k]}/></label>)}
          <button className="primary" disabled={busy}>保存单价</button>
        </form>
        <h2>用户余额</h2>
        {users.map(u=><form key={u.id} onSubmit={e=>{e.preventDefault();void save("admin/balance",{uid:u.id,expected:u.balance,target:Number(new FormData(e.currentTarget).get("balance"))});}}>
          <label>{u.username} · {u.role==="admin"?"管理员":"用户"} · 当前 {u.balance} 积分
            <input name="balance" type="number" required min="0" max="1000000" defaultValue={u.balance}/></label>
          <button className="secondary" disabled={busy}>更新余额</button>
        </form>)}
      </>}
      <h2>使用明细</h2>
      <div className="usage-table"><table><thead><tr>{["时间","用户","操作","用量","积分变动","状态"].map(k=><th key={k}>{k}</th>)}</tr></thead>
      <tbody>{data.logs.map((l,i)=><tr key={i}><td>{new Date(l.created).toLocaleString()}</td><td>{l.username}</td><td>{names[l.service]} {l.actor && "· "+l.actor}</td>
        <td>{l.service==="live"?l.units+" 秒授权 / "+(l.observed??"未上报")+" 秒播放":"1 次"}</td><td>{l.status==="refunded"?0:-l.points}</td><td>{labels[l.status]} {management && (l.status==="reserved" || l.status==="submitted") && Date.now()-l.created>600000 && <button disabled={busy} className="secondary" onClick={()=>void save("admin/refund",{id:l.id})}>返还预扣</button>}</td></tr>)}</tbody></table></div>
      {!data.logs.length && <p>暂无记录</p>}
      <button className="secondary" disabled={!offset} onClick={()=>setOffset(v=>v-50)}>上一页</button>
      <button className="secondary" disabled={data.logs.length<50} onClick={()=>setOffset(v=>v+50)}>下一页</button>
    </>}
    <button className="text-button" onClick={()=>refresh(v=>v+1)}>刷新</button>
  </section>;
}
