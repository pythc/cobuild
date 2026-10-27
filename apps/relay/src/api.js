let widgetToken="";
let widgetReady;
export const sourceApp = new URLSearchParams(location.search).get("app") || "makit";
export const bridgedWidget = new URLSearchParams(location.search).get("bridge") === "1";
async function widgetIdentity() {
  if(!bridgedWidget)return;
  if(widgetReady)return widgetReady;
  widgetReady=new Promise(async(resolve,reject)=>{
    const verifier=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
    const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))))).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
    const timer=setTimeout(()=>{window.removeEventListener("message",receive);widgetReady=null;reject(Error("客服连接超时，请关闭后重试"));},20000);
    async function receive(event){
      if(event.source!==window.parent || event.data?.app!==sourceApp || event.data?.type!=="RELAY_WIDGET_GRANT")return;
      const allowed=["https://makit.110-lab.cn","https://internal.110-lab.cn","https://knowledge.110-lab.cn","https://exam.110-lab.cn","https://aigrading.110-lab.cn","https://fcncvoyreb8p.feishuapp.com"];
      if(!allowed.includes(event.origin))return;
      clearTimeout(timer);window.removeEventListener("message",receive);
      try{const value=await request("/auth/widget",{method:"POST",body:JSON.stringify({grant:event.data.grant,verifier})});widgetToken=value.token;setTimeout(()=>{widgetToken="";widgetReady=null;},240000);resolve();}catch(e){widgetReady=null;reject(e);}
    }
    window.addEventListener("message",receive);
    window.parent.postMessage({type:"RELAY_WIDGET_READY",app:sourceApp,challenge},"*");
  });
  return widgetReady;
}
export async function request(path, options = {}) {
  if(bridgedWidget && path.startsWith("/api/"))await widgetIdentity();
  const response = await fetch("/relay" + path, {
    signal: AbortSignal.timeout(35000),
    credentials: "same-origin",
    ...options,
    headers: { "content-type": "application/json", ...(widgetToken?{Authorization:"RelayWidget "+widgetToken}:{}), ...options.headers },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("服务暂时无法连接");
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof result.message === "string"
          ? result.message
          : result.error?.message || "操作失败",
      ),
      { status: response.status, loginPath: result.loginPath },
    );
  return result;
}
export const mutation = (
  path,
  body,
  method = "POST",
  key = crypto.randomUUID(),
) =>
  request(path, {
    method,
    body: JSON.stringify(body),
    headers: { "idempotency-key": key },
  });
export async function connect(operator) {
  const health = await request("/api/healthz");
  if (health.mode === "live-chatwoot") return request("/api/relay/profile");
  throw new Error("客服连接尚未就绪");
}
export const state = (operator) =>
  request("/api/relay/state?view=" + (operator ? "operator" : "customer"));

export async function login(operator) {
  if(bridgedWidget){widgetReady=null;await widgetIdentity();return;}
  if (window.top === window.self) {
    location.href =
      "/relay/auth/start?view=" + (operator ? "operator" : "customer");
    return;
  }
  const popup = window.open(
    "about:blank",
    "relay-login",
    "popup,width=560,height=720",
  );
  if (!popup) throw new Error("请允许打开登录窗口");
  const bytes = crypto.getRandomValues(new Uint8Array(32)),
    verifier = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    ),
    challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("登录未完成，请重试"));
    }, 600000);
    async function receive(event) {
      if (
        event.origin !== location.origin ||
        event.source !== popup ||
        event.data?.type !== "RELAY_AUTH_COMPLETE"
      )
        return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      try {
        await mutation("/auth/finish-embed", {
          code: event.data.code,
          verifier,
        });
        resolve();
      } catch (e) {
        reject(e);
      }
    }
    window.addEventListener("message", receive);
    popup.location.href =
      "/relay/auth/start?view=customer&embed_challenge=" + challenge;
  });
}
export async function assetBlob(path,signal) {
  if(!/^\/relay\/api\/relay\/attachments\/[\w-]+\/\d+(?:\?[^#]*)?$/.test(path))throw Error('附件地址无效');
  if(bridgedWidget)await widgetIdentity();
  const r=await fetch(path,{credentials:'same-origin',signal,headers:widgetToken?{Authorization:'RelayWidget '+widgetToken}:{}});
  if(!r.ok)throw Error('附件读取失败，请重试');
  return r.blob();
}
