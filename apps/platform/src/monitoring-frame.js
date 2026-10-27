import './relay-widget-entry.js';
// One retained iframe, not one heavyweight Grafana application per tab/host.
export function createGrafanaNavigation(frame){
  let current='';
  return {
    navigate(url,{force=false}={}){
      if(!force&&current===url&&frame.getAttribute('src')===url)return false;
      current=url;frame.setAttribute('src',url);return true;
    },
    clear(){current='';frame.removeAttribute('src');},
  };
}
export function refreshGrafanaData(frame){
  try{
    const button=[...frame.contentDocument.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Refresh'||b.textContent.trim()==='Refresh');
    if(button&&!button.disabled){button.click();return true;}
  }catch{}
  return false;
}
