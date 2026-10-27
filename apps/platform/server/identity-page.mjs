import {readFileSync} from 'node:fs';
import {escapeHTML} from './render.mjs';
export function renderIdentityPage(title,content){const html=readFileSync(new URL('../dist/identity.html',import.meta.url),'utf8');return html.replace(/<title>.*?<\/title>/,()=>'<title>'+escapeHTML(title)+' · 110 CoBuild</title>').replace(/<section class="card"[\s\S]*?<\/section>/,()=>`<section class="card" aria-labelledby="title"><p class="eyebrow">统一认证</p><h1 id="title">${escapeHTML(title)}</h1><div class="identity-content">${content}</div></section>`).replace(/<script type="module">[\s\S]*?<\/script>/,'');}
