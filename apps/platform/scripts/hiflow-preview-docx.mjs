import JSZip from 'jszip';
const escape=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
// Fictional local preview content, never imported into a production database.
export async function hiflowPreviewResume(){
  const zip=new JSZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const rows=[
    ['陈知夏（虚构）',40,true],['计算机相关专业 · 开发方向',22,false],
    ['个人简介',30,true],['喜欢把想法落地为可用的产品。具备前端开发、接口设计和数据处理经验，关注真实使用场景中的体验与可靠性。',22,false],
    ['项目经历',30,true],['文档检索系统（个人项目）',24,true],['基于 Vue 和 Node.js 实现文档上传、分类检索与问答展示。负责前端页面、接口联调和测试，完成容器化部署。',22,false],['为检索结果补充来源与页码，针对异常文件、重复上传和空结果设计反馈，持续改进用户查找资料的效率。',22,false],
    ['图像识别小工具（课程项目）',24,true],['使用 Python 实现图像预处理、模型调用和结果展示。记录不同数据集上的识别表现，整理误识别样例并验证改进方案。',22,false],
    ['技术能力',30,true],['前端：Vue、JavaScript、HTML/CSS，组件开发与响应式布局。',22,false],['后端：Node.js、Express、REST API，了解数据库设计。',22,false],['工具：Git、Linux、Docker，熟悉基本测试与部署流程。',22,false],
    ['学习与协作',30,true],['能独立拆解问题并验证方案，愿意通过文档和代码评审与团队协作。对计算机视觉和 AI 应用开发保持兴趣。',22,false]
  ];
  const paragraphs=rows.map(([text,size,bold])=>'<w:p><w:pPr><w:spacing w:before="'+(bold?'160':'0')+'" w:after="120" w:line="320" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="PingFang SC"/>'+(bold?'<w:b/>':'')+'<w:sz w:val="'+size+'"/><w:color w:val="'+(bold?'20242C':'526078')+'"/></w:rPr><w:t>'+escape(text)+'</w:t></w:r></w:p>').join('');
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraphs+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
