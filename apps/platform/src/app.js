import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { initWorkbench } from './workbench.js';
import config from './projects.json';
import { EMBEDDED_APPS, initEmbeddedWorkspace } from './embedded-workspace.js';
import {validVersion,WORKBENCH_VERSION} from './workbench-release.js';

const portal=initWorkbench(config,{assetBase:'https://internal.110-lab.cn',embeddedIds:Object.keys(EMBEDDED_APPS)});
const workspace=initEmbeddedWorkspace();
// The same compiled resource can be previewed outside an MCP host.
if(window.parent!==window){
  const app=new App({name:'110lab',version:WORKBENCH_VERSION||'0.22.0'},{},{autoResize:false});
  new OpenAIExtensions(app);
  app.ontoolresult=reply=>{
    if(!Object.hasOwn(reply?.structuredContent||{},'installedPluginVersion'))return;
    const value=reply?.structuredContent?.installedPluginVersion;
    workspace?.setReleaseContext({installedPluginVersion:validVersion(value)?value:null});
  }; // Forward public version information only; never re-call the opener.
  try{
    await app.connect();
    portal.setExternalOpener(url=>app.openLink({url}));
    workspace?.setExternalOpener(url=>app.openLink({url}));
    workspace?.setFileDownloader(app.getHostCapabilities()?.downloadFile?params=>app.downloadFile(params,{timeout:120000}):null);
    workspace?.setToolCaller(params=>app.callServerTool(params,{timeout:params.arguments?.cancel?10000:300000}));
    const context=app.getHostContext();
    if(context?.displayMode!=='fullscreen'&&context?.availableDisplayModes?.includes('fullscreen')){
      await app.requestDisplayMode({mode:'fullscreen'});
    }
  }catch(error){
    console.error('110lab host connection failed',error);
    // Keep normal HTTPS anchors usable if the host bridge is unavailable.
  }
}
