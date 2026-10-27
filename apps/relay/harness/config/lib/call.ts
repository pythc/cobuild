export async function call(name:string,args:unknown){
 const token=process.env.RELAY_AI_SESSION;
 if(!token||!/^[a-f0-9]{64}$/.test(token))throw Error('本轮会话已失效');
 const response=await fetch('http://127.0.0.1:5494/tool',{method:'POST',redirect:'error',signal:AbortSignal.timeout(35000),headers:{'Content-Type':'application/json','X-Relay-Session':token},body:JSON.stringify({name,args})});
 let text=await response.text();if(text.length>48000)throw Error('查询结果过大');
 if(!response.ok)throw Error('查询权限不足或会话已失效');return text;
}
