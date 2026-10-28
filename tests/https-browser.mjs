// Own headless browser only. Test CA is not installed in the OS or personal browsers.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.COBUILD_PLAYWRIGHT_MODULE));
const config=JSON.parse(readFileSync(process.env.COBUILD_CONFIG));
const origins=['platform','makit','weknow'].map(k=>config.origins[k]);
const hosts=origins.map(o=>new URL(o).hostname);
assert.ok(hosts.every(h=>h.endsWith('.cobuild.test')));
const key=new X509Certificate(readFileSync(process.env.COBUILD_TEST_TLS_CERT)).publicKey.export({type:'spki',format:'der'});
const pin=createHash('sha256').update(key).digest('base64');
const args=['--no-proxy-server','--disable-background-networking','--host-resolver-rules='+hosts.map(h=>'MAP '+h+' 127.0.0.1').join(',')];
const executablePath=process.env.COBUILD_CHROMIUM_EXECUTABLE;
let browser,context,checks=0;
function check(v,label){assert.ok(v,label);checks++;}
async function scoped(context){
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    return origins.includes(url.origin)||url.protocol==='data:'?route.continue():route.abort();
  });
}
try {
  browser=await chromium.launch({headless:true,args,executablePath});
  context=await browser.newContext();await scoped(context);
  const untrusted=await context.newPage();let rejected=false;
  try{await untrusted.goto(config.origins.platform+'/login');}catch(error){rejected=/ERR_CERT_AUTHORITY_INVALID/.test(error.message);}
  check(rejected,'browser without the isolated test pin rejects the private CA');
  await browser.close();browser=null;
  browser=await chromium.launch({headless:true,args:[...args,'--ignore-certificate-errors-spki-list='+pin],executablePath});
  context=await browser.newContext();await scoped(context);
  let page=await context.newPage();
  await page.goto(config.origins.platform+'/login');
  check(await page.evaluate(()=>isSecureContext),'browser login uses a secure context');
  await page.locator('input[name=email]').fill('member@example.test');
  await page.locator('input[name=password]').fill('Recovered member local password 123');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.waitForURL(config.origins.platform+'/workbench');
  for(const app of ['makit','weknow']){
    await page.goto(config.origins[app]+(app==='makit'?'/auth/start':'/api/auth/identity/login'));
    check(new URL(page.url()).origin===config.origins.platform,app+' browser reaches the configured HTTPS issuer');
    await page.getByRole('button',{name:'确认连接',exact:true}).click();
    await page.waitForURL(url=>url.origin===config.origins[app]&&!url.pathname.includes('callback'));
    check(await page.evaluate(()=>isSecureContext),app+' callback returns to a secure context');
  }
  for(const [app,name] of [['platform','__Host-cobuild_session'],['makit','makit_session'],['weknow','authToken']]){
    const cookies=await context.cookies(config.origins[app]),session=cookies.find(c=>c.name===name);
    check(session?.secure&&session?.httpOnly&&session?.sameSite==='Lax',app+' actual browser stores Secure HttpOnly Lax session');
    check(session?.domain===new URL(config.origins[app]).hostname,app+' browser session is host-only');
    check(session?.expires>Date.now()/1000+86400,app+' session is persistent rather than a browser-session cookie');
    check(cookies.every(c=>c.name===name||!['__Host-cobuild_session','makit_session','authToken'].includes(c.name)),app+' does not receive another app host session');
  }
  const state=await context.storageState();writeFileSync(process.env.COBUILD_BROWSER_STATE,JSON.stringify(state),{mode:0o600});
  await context.close();context=await browser.newContext({storageState:state});await scoped(context);page=await context.newPage();
  const endpoint={platform:'/api/auth/session',makit:'/api/selfhost/session',weknow:'/api/users/me'};
  async function status(app){
    await page.goto(config.origins[app]+({platform:'/healthz',makit:'/healthz',weknow:'/api/auth/identity/status'})[app]);
    return page.evaluate(async({path,post})=>{
      const r=await fetch(path,{method:post?'POST':'GET',...(post?{headers:{'Content-Type':'application/json'},body:'{}'}:{})});return r.status;
    },{path:endpoint[app],post:app==='weknow'});
  }
  for(const app of ['platform','makit','weknow'])check(await status(app)===200,app+' browser context restart retains real session');
  await page.goto(config.origins.platform+'/workbench');
  await page.screenshot({path:process.env.COBUILD_BROWSER_SCREENSHOT,fullPage:false});
  const loggedOut=await page.evaluate(async()=>{
    const session=await(await fetch('/api/auth/session')).json();
    return(await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{}'})).status;
  });
  check(loggedOut===200,'browser central logout succeeds');
  for(const app of ['platform','makit','weknow'])check(await status(app)===401,app+' browser session rejects central logout immediately');
  console.log(JSON.stringify({passed:true,checks,browserVersion:browser.version(),scope:'isolated Chromium HTTPS cookie and callback acceptance',certificateTrust:'exact test SPKI pin; independent CA checks run separately',systemTrustModified:false}));
} finally {if(browser)await browser.close();}
