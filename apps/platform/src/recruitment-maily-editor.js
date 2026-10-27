import {
  mailEndSelection,
  insertMailContent,
} from "./recruitment-editor-selection.js";
import { uploadMailImage } from "./recruitment-image-upload.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server.browser";
import { Editor } from "@maily-to/core";
import {
  VariableExtension,
  ImageUploadExtension,
} from "@maily-to/core/extensions";
import {
  text,
  heading1,
  heading2,
  bulletList,
  orderedList,
  button,
  image,
  divider,
  columns,
  spacer,
} from "@maily-to/core/blocks";
import { Maily } from "@maily-to/render";
import { preservedLayoutExtension } from "./recruitment-preserved-layout.js";
import {
  freezeMailDocument,
  mailDocumentText,
  legacyMailDocument,
  renderMailDocument,
} from "./maily-mail-document.js";
import { variableNames } from "./recruitment-tasks.js";
const escape = (s) =>
  String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const dataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
const blocks = [
  {
    title: "文字",
    commands: [
      [text, "正文"],
      [heading1, "大标题"],
      [heading2, "标题"],
      [bulletList, "项目列表"],
      [orderedList, "编号列表"],
    ].map(([block, title]) => ({ ...block, title })),
  },
  {
    title: "邮件组件",
    commands: [
      [button, "按钮"],
      [image, "图片"],
      [divider, "分隔线"],
      [columns, "分栏"],
      [spacer, "间距"],
    ].map(([block, title]) => ({ ...block, title })),
  },
];
export function mailEditor(
  session,
  template,
  container,
  onError,
  onChange = () => {},
) {
  let disposed = false,
    disabled = false,
    instance = null,
    loading = true,
    uploads = 0,
    invalid = null,
    cache = { html: template.html || "", body: template.body || "" };
  const mount = document.createElement("div");
  mount.className = "hf-maily";
  container.append(mount);
  const root = createRoot(mount),
    imageIds = new Map(),
    imageUrls = new Map();
  const tools = document.createElement("div");
  tools.className = "hf-editor-tools";
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", "邮件正文工具");
  container.prepend(tools);
  const controls = [];
  const add = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.disabled = true;
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      if (
        instance &&
        !instance.isDestroyed &&
        !disabled &&
        !loading &&
        !uploads
      ) {
        try {
          if (
            ["正文", "标题", "加粗", "列表"].includes(label) &&
            instance.isActive("htmlCodeBlock")
          )
            throw Error("请使用原版布局上的「编辑文字」修改内容");
          fn(instance);
        } catch (e) {
          onError(e.message);
        }
      }
    };
    controls.push(b);
    tools.append(b);
  };
  add("正文", (e) => e.chain().focus().setParagraph().run());
  add("标题", (e) => e.chain().focus().toggleHeading({ level: 2 }).run());
  add("加粗", (e) => e.chain().focus().toggleBold().run());
  add("列表", (e) => e.chain().focus().toggleBulletList().run());
  add("按钮", (e) =>
    insertMailContent(e, [
      {
        type: "button",
        attrs: {
          text: "查看详情",
          url: "https://example.com",
          variant: "filled",
          alignment: "left",
          borderRadius: "smooth",
          buttonColor: "#262626",
          textColor: "#ffffff",
        },
      },
      { type: "paragraph" },
    ]),
  );
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/webp,image/gif";
  file.hidden = true;
  container.append(file);
  add("图片", () => file.click());
  add("分隔线", (e) =>
    insertMailContent(e, [{ type: "horizontalRule" }, { type: "paragraph" }]),
  );
  add("撤销", (e) => e.chain().focus().undo().run());
  add("重做", (e) => e.chain().focus().redo().run());
  const hint = document.createElement("p");
  hint.className = "hf-editor-hint";
  hint.textContent = "输入 / 插入组件，选中文字设置格式";
  container.append(hint);
  function paint() {
    for (const control of controls)
      control.disabled = disabled || loading || uploads > 0;
    if (instance && !instance.isDestroyed)
      instance.setEditable(!disabled && !loading && !uploads, false);
    file.disabled = disabled || loading || uploads > 0;
  }
  function update(editor, changed) {
    if (disposed) return;
    instance = editor;
    try {
      const json = freezeMailDocument(editor.getJSON(), imageIds);
      cache = {
        html: renderMailDocument(json, (native) => {
          const render = new Maily(native);
          render.setVariableFormatter(({ variable }) => "{{" + variable + "}}");
          return renderToStaticMarkup(
            React.createElement(React.Fragment, null, ...render.children()),
          );
        }),
        body:
          mailDocumentText(json).trim() ||
          "请使用支持 HTML 的邮件客户端查看此邮件",
      };
      invalid = null;
      if (changed) onChange();
    } catch (e) {
      invalid = e;
      onError(e.message);
    }
    paint();
  }
  async function upload(blob) {
    if (disposed || disabled) throw Error("编辑器不可用");
    if (!blob.size || blob.size > 2 * 1024 * 1024)
      throw Error("图片需小于 2 MB");
    uploads++;
    paint();
    hint.textContent = "正在上传图片";
    try {
      const { url, id } = await uploadMailImage(session, blob, {
        isCurrent: () => !disposed,
      });
      imageIds.set(url, id);
      return url;
    } catch (e) {
      if (!disposed) onError(e.message);
      throw e;
    } finally {
      uploads--;
      if (!disposed) {
        paint();
        hint.textContent = "输入 / 插入组件，选中文字设置格式";
      }
    }
  }
  file.onchange = async () => {
    const blob = file.files[0];
    file.value = "";
    if (!blob) return;
    try {
      const url = await upload(blob);
      if (!disposed)
        insertMailContent(instance, [
          { type: "image", attrs: { src: url, alt: blob.name, width: 480 } },
          { type: "paragraph" },
        ]);
    } catch {
      /* reported by upload */
    }
  };
  const labels = {
    ...variableNames,
    ...Object.fromEntries(
      (template.variables || []).map((v) => [v.key, v.label]),
    ),
  };
  async function start() {
    try {
      const editorDocument = legacyMailDocument(template);
      const downloadImage = async (id) => {
        if (imageUrls.has(id)) return imageUrls.get(id);
        const url = await dataUrl(await session.download("images/" + id));
        imageIds.set(url, id);
        imageUrls.set(id, url);
        return url;
      };
      const hydrate = async (node) => {
        if (disposed) throw Error("编辑器已关闭");
        if (node.type === "variable")
          node.attrs.label =
            labels[node.attrs.id] || node.attrs.label || node.attrs.id;
        if (node.type === "image") {
          const id = /^cid:lab-([a-f0-9]{64})$/.exec(
            node.attrs?.src || "",
          )?.[1];
          if (!id) throw Error("模板图片无效");
          node.attrs.src = await downloadImage(id);
        }
        if (node.type === "htmlCodeBlock")
          for (const match of node.content
            .map((n) => n.text || "")
            .join("")
            .matchAll(/src="cid:lab-([a-f0-9]{64})"/g))
            await downloadImage(match[1]);
        for (const child of node.content || []) await hydrate(child);
      };
      await hydrate(editorDocument);
      if (disposed) return;
      root.render(
        React.createElement(Editor, {
          ...(editorDocument ? { contentJson: editorDocument } : {}),
          blocks,
          extensions: [
            preservedLayoutExtension(imageUrls),
            VariableExtension.configure({
              variables: Object.entries(labels).map(([name, label]) => ({
                name,
                label,
                required: true,
              })),
            }),
            ImageUploadExtension.configure({
              allowedMimeTypes: [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
              ],
              onImageUpload: upload,
            }),
          ],
          config: {
            hasMenuBar: false,
            hideContextMenu: false,
            spellCheck: false,
            contentClassName: "hf-letter",
            bodyClassName: "hf-editor-body",
            autofocus: false,
            immediatelyRender: true,
          },
          editable: !disabled,
          onCreate(editor) {
            loading = false;
            update(editor, false);
            editor.view.dispatch(
              editor.state.tr.setSelection(mailEndSelection(editor.state.doc)),
            );
          },
          onUpdate(editor) {
            update(editor, true);
          },
        }),
      );
    } catch (e) {
      if (!disposed) {
        invalid = e;
        loading = false;
        onError(e.message);
      }
    }
  }
  void start();
  return {
    snapshot() {
      if (loading || uploads || invalid)
        throw Error("请等待编辑器加载和图片上传完成");
      return freezeMailDocument(instance.getJSON(), imageIds);
    },
    destroy() {
      disposed = true;
      root.unmount();
    },
    setDisabled(value) {
      disabled = value;
      paint();
    },
    insertVariable(key) {
      if (
        !disabled &&
        !loading &&
        !uploads &&
        /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)
      )
        insertMailContent(
          instance,
          {
            type: "variable",
            attrs: { id: key, label: labels[key] || key, required: true },
          },
          { inline: true },
        );
    },
    get pending() {
      return loading || uploads > 0;
    },
    value() {
      if (loading || uploads) throw Error("请等待编辑器加载和图片上传完成");
      if (invalid) throw invalid;
      return { ...cache };
    },
  };
}
