import React, { useState, useMemo, useRef, useEffect } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { HTMLCodeBlockExtension } from "@maily-to/core/extensions";

// No imported HTML ever enters the parent document. Even while editing source,
// previews have neither scripts, forms, remote images nor same-origin access.
export function preservedFrame(html, imageUrls = new Map()) {
  const source = html.replace(
    /src="cid:lab-([a-f0-9]{64})"/g,
    (_, id) => 'src="' + (imageUrls.get(id) || "") + '"',
  );
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><style>body{font:15px/1.75 system-ui;padding:20px;color:#243047;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{padding:8px}a{color:#2446bd}</style></head><body>" +
    source +
    "</body></html>"
  );
}
function textFields(html) {
  const doc = new DOMParser().parseFromString(html, "text/html"),
    nodes = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode())
    if (walker.currentNode.textContent.trim()) nodes.push(walker.currentNode);
  return { doc, nodes };
}
export function preservedLayoutExtension(imageUrls) {
  function Layout({ node, editor, getPos }) {
    const html = node.textContent,
      [mode, setMode] = useState(null),
      [source, setSource] = useState(html),
      [values, setValues] = useState([]),
      dialog = useRef(null);
    const fields = useMemo(() => textFields(html), [html]);
    useEffect(() => {
      if (mode) dialog.current?.showModal();
    }, [mode]);
    const open = (mode) => {
      setSource(html);
      setValues(fields.nodes.map((n) => n.textContent));
      setMode(mode);
    };
    const close = () => {
      dialog.current?.close();
      setMode(null);
    };
    const apply = () => {
      let next = source;
      if (mode === "text") {
        const { doc, nodes } = textFields(html);
        nodes.forEach((n, i) => (n.textContent = values[i]));
        next = doc.body.innerHTML;
      }
      if (!next.trim()) return;
      const pos = getPos();
      if (typeof pos !== "number" || !editor.isEditable || editor.isDestroyed)
        return;
      editor.view.dispatch(
        editor.state.tr.replaceWith(
          pos + 1,
          pos + node.nodeSize - 1,
          editor.schema.text(next),
        ),
      );
      close();
    };
    return React.createElement(
      NodeViewWrapper,
      { className: "hf-preserved-layout", contentEditable: false },
      React.createElement(
        "div",
        { className: "hf-preserved-head" },
        React.createElement("span", null, "原版布局"),
        React.createElement(
          "button",
          {
            type: "button",
            disabled: !editor.isEditable,
            onClick: () => open("text"),
          },
          "编辑文字",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            disabled: !editor.isEditable,
            onClick: () => open("html"),
          },
          "HTML",
        ),
      ),
      React.createElement("iframe", {
        title: "原版布局内容",
        sandbox: "",
        srcDoc: preservedFrame(html, imageUrls),
        className: "hf-preserved-frame",
      }),
      mode &&
        React.createElement(
          "dialog",
          {
            ref: dialog,
            className: "rw-mail-dialog hf-layout-dialog",
            "aria-label": mode === "text" ? "编辑原版文字" : "编辑原版 HTML",
            onCancel: () => setMode(null),
            onClose: () => setMode(null),
          },
          React.createElement(
            "h3",
            null,
            mode === "text" ? "编辑原版文字" : "编辑原版 HTML",
          ),
          React.createElement(
            "p",
            { className: "rt-help" },
            mode === "text"
              ? "保留原有排版，仅修改文字；变量请保留 {{变量标识}}。"
              : "修改后将在保存时校验邮件支持的 HTML 格式。",
          ),
          mode === "text"
            ? React.createElement(
                "div",
                { className: "hf-layout-fields" },
                fields.nodes.map((_, i) =>
                  React.createElement(
                    "label",
                    { key: i, className: "rt-field" },
                    React.createElement("span", null, "文字 " + (i + 1)),
                    React.createElement("textarea", {
                      "aria-label": "文字 " + (i + 1),
                      value: values[i],
                      onChange: (e) =>
                        setValues((v) =>
                          v.map((s, j) => (j === i ? e.target.value : s)),
                        ),
                    }),
                  ),
                ),
              )
            : React.createElement("textarea", {
                "aria-label": "原版 HTML",
                className: "hf-html-source",
                value: source,
                onChange: (e) => setSource(e.target.value),
                spellCheck: false,
              }),
          React.createElement(
            "footer",
            null,
            React.createElement(
              "button",
              { type: "button", className: "rt-button", onClick: close },
              "取消",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "rt-button rt-primary",
                onClick: apply,
              },
              "应用修改",
            ),
          ),
        ),
    );
  }
  return HTMLCodeBlockExtension.extend({
    atom: true,
    isolating: true,
    content: "text*",
    addNodeView() {
      return ReactNodeViewRenderer(Layout);
    },
  });
}
