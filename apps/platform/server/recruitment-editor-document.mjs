import { imageIds, cleanMailHtml } from "./recruitment-rich-mail.mjs";
const nodes = new Set([
  "doc",
  "paragraph",
  "text",
  "heading",
  "variable",
  "image",
  "button",
  "horizontalRule",
  "hardBreak",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "columns",
  "column",
  "section",
  "spacer",
  "footer",
  "htmlCodeBlock",
]);
const marks = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "textStyle",
  "color",
  "textColor",
  "fontFamily",
]);
// Editor metadata never participates in delivery. Only bounded declarative
// nodes are restored, and all image references must match uploaded MIME parts.
export function validateEditorDocument(value, html) {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 120000) throw Error("邮件编辑结构过大");
  const document = JSON.parse(serialized),
    images = new Set(imageIds(html));
  let count = 0;
  const attrs = (value, depth = 0) => {
    if (depth > 5) throw Error("编辑属性嵌套过深");
    for (const [key, item] of Object.entries(value || {})) {
      if (/^(?:__proto__|constructor|prototype|on[a-z])/i.test(key))
        throw Error("编辑属性无效");
      if (
        typeof item === "function" ||
        (typeof item === "string" && item.length > 10000)
      )
        throw Error("编辑属性过长");
      if (/(?:url|href)$/i.test(key) && item) {
        let url;
        try {
          url = new URL(item);
        } catch {
          throw Error("编辑链接无效");
        }
        if (
          !["https:", "mailto:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error("编辑链接无效");
      }
      if (key === "src" && item && !/^cid:lab-[a-f0-9]{64}$/.test(item))
        throw Error("编辑图片必须使用已上传图片");
      if (item && typeof item === "object") attrs(item, depth + 1);
    }
  };
  const visit = (node, depth = 0, parent = null) => {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !nodes.has(node.type) ||
      depth > 30 ||
      ++count > 5000
    )
      throw Error("编辑结构无效");
    if (
      node.text !== undefined &&
      (typeof node.text !== "string" ||
        node.text.length > (parent === "htmlCodeBlock" ? 60000 : 20000))
    )
      throw Error("编辑正文无效");
    attrs(node.attrs);
    if (node.type === "htmlCodeBlock") {
      if (
        parent !== "doc" ||
        !Array.isArray(node.content) ||
        node.content.some((c) => c.type !== "text" || c.marks?.length)
      )
        throw Error("原版布局只能作为顶层内容块");
      const source = node.content.map((c) => c.text || "").join("");
      // DOMParser emits <img>, while sanitize-html emits <img />. Accept only
      // that lexical difference, never stripped event handlers or remote URLs.
      const voids = (value) =>
        value.replace(
          /<(img|br|hr)\b([^<>]*?)\s*\/?>/gi,
          (_tag, name, attrs) =>
            "<" + name + attrs.trimEnd().replace(/\/$/, "").trimEnd() + " />",
        );
      const canonical = cleanMailHtml(source);
      if (
        !source ||
        voids(source) !== voids(canonical) ||
        !html.includes(canonical)
      )
        throw Error("原版布局与邮件正文不一致或包含不支持的内容");
      for (const id of imageIds(source))
        if (!images.has(id)) throw Error("编辑图片与邮件正文不一致");
    }
    if (
      node.type === "image" &&
      !images.has(String(node.attrs?.src || "").slice(8))
    )
      throw Error("编辑图片与邮件正文不一致");
    if (
      node.type === "variable" &&
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(node.attrs?.id || "")
    )
      throw Error("编辑变量无效");
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks) || node.marks.length > 20)
        throw Error("编辑样式无效");
      for (const mark of node.marks) {
        if (!marks.has(mark.type)) throw Error("编辑样式无效");
        attrs(mark.attrs);
      }
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw Error("编辑结构无效");
      for (const child of node.content) visit(child, depth + 1, node.type);
    }
  };
  if (document?.type !== "doc") throw Error("编辑结构无效");
  visit(document);
  return serialized;
}
