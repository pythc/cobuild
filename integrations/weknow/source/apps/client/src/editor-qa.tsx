import React from 'react';
import {createRoot} from 'react-dom/client';
import {MantineProvider,Button,Group,Text,SegmentedControl} from '@mantine/core';
import {ModalsProvider} from '@mantine/modals';
import {QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {EditorContent,useEditor} from '@tiptap/react';
import {UndoRedo} from '@tiptap/extensions';
import {useSetAtom} from 'jotai';
import {mainExtensions} from './features/editor/extensions/extensions';
import {BlockFormatMenu} from './features/editor/components/block-format-menu/block-format-menu';
import {EditorLinkMenu} from './features/editor/components/link/link-menu';
import {showLinkMenuAtom} from './features/editor/atoms/editor-atoms';
import {insertKnowledgeLink} from './features/editor/extensions/knowledge-link';
import {queryClient} from '@/main.tsx';
import './i18n';
import i18n from './i18n';
import '@mantine/core/styles.css';
import './features/editor/styles/index.css';
void i18n.changeLanguage('zh-CN');
function QA(){
 const [mode,setMode]=React.useState('edit');const showLink=useSetAtom(showLinkMenuAtom);
 const editor=useEditor({extensions:[...mainExtensions,UndoRedo],content:'<h1>公式插入与快捷输入</h1><p>把相关资料放进正文，同事可以直接打开查看。</p><p>这段文字用于测试段落转换、拖动和下方插入。菜单操作应当保留这段文字。</p><p>下一段：用于检查插入位置与拖动顺序。</p>'});

 if(!editor)return null;
 return <><header style={{height:60,borderBottom:'1px solid #e9ecef',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 32px'}}><b style={{color:'#307c72'}}>WeKnow</b><Text size="sm" c="dimmed">公式修复验收 · 本地示例</Text><SegmentedControl value={mode} onChange={v=>{setMode(v);editor.setEditable(v==='edit')}} data={[{value:'edit',label:'编辑'},{value:'read',label:'阅读'}]}/></header><main style={{maxWidth:880,margin:'50px auto',padding:'0 30px'}}><Group mb={24}><Button variant="default" size="xs" disabled={mode==='read'} onClick={()=>showLink(true)}>插入链接</Button><Button variant="subtle" size="xs" disabled={mode==='read'} onClick={()=>editor.commands.undo()}>撤销</Button><Button variant="subtle" size="xs" disabled={mode==='read'} onClick={()=>editor.commands.redo()}>重做</Button><Button variant="default" size="xs" onClick={()=>{const saved=editor.getJSON();editor.commands.setContent(saved)}}>保存并重新载入</Button></Group><EditorContent editor={editor}/><BlockFormatMenu editor={editor}/><EditorLinkMenu editor={editor}/></main></>;
}
createRoot(document.getElementById('qa-root')!).render(<MemoryRouter initialEntries={['/s/preview/p/editor-qa1234567']}><MantineProvider><ModalsProvider><QueryClientProvider client={queryClient}><QA/></QueryClientProvider></ModalsProvider></MantineProvider></MemoryRouter>);
