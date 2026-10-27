// Serialize a Maily document without leaking temporary data URLs. This also
// preserves variable keys in the plain-text MIME alternative (not chip labels).
export function freezeMailDocument(document, imageIds) {
  const json = structuredClone(document);
  function visit(node) {
    if (node.type === "image") {
      const id = imageIds.get(node.attrs?.src);
      if (!/^[a-f0-9]{64}$/.test(id || ""))
        throw Error("图片尚未上传完成，请重新插入");
      node.attrs.src = "cid:lab-" + id;
    }
    for (const child of node.content || []) visit(child);
  }
  visit(json);
  return json;
}
export function mailDocumentText(node) {
  if (node.type === "htmlCodeBlock")
    return (node.content || [])
      .map(mailDocumentText)
      .join("")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|tr)>/gi, "\n\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  if (node.type === "text") return node.text || "";
  if (node.type === "variable") return "{{" + node.attrs.id + "}}";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "button")
    return (
      (node.attrs.text || "") +
      (node.attrs.url ? " (" + node.attrs.url + ")" : "") +
      "\n\n"
    );
  if (node.type === "image")
    return node.attrs.alt ? "[" + node.attrs.alt + "]\n\n" : "";
  const value = (node.content || []).map(mailDocumentText).join("");
  return (
    value +
    (["paragraph", "heading", "listItem", "horizontalRule", "column"].includes(
      node.type,
    )
      ? "\n\n"
      : "")
  );
}

// Existing HTML is preserved as a first-class Maily block, never parsed into
// a lossy approximation of a table, typography or image alignment.
export function legacyMailDocument(template) {
  if (template.editorDocument) return structuredClone(template.editorDocument);
  if (template.html)
    return {
      type: "doc",
      content: [
        {
          type: "htmlCodeBlock",
          attrs: { language: "html", activeTab: "preview" },
          content: [{ type: "text", text: template.html }],
        },
      ],
    };
  const inline = (text) =>
    text
      .split(/(\{\{[A-Za-z][A-Za-z0-9_]*\}\})/g)
      .filter(Boolean)
      .map((part) =>
        /^\{\{/.test(part)
          ? {
              type: "variable",
              attrs: { id: part.slice(2, -2), required: true },
            }
          : { type: "text", text: part },
      );
  return {
    type: "doc",
    content: String(template.body || "")
      .split(/\n{2,}/)
      .map((text) => ({
        type: "paragraph",
        content: text
          .split("\n")
          .flatMap((line, index) => [
            ...(index ? [{ type: "hardBreak" }] : []),
            ...inline(line),
          ]),
      })),
  };
}

// Render top-level preserved blocks verbatim; Maily's default HTML block
// renderer adds a presentation table, which would change an old layout.
export function renderMailDocument(document, renderNative) {
  return (document.content || [])
    .map((node) =>
      node.type === "htmlCodeBlock"
        ? (node.content || [])
            .map((child) =>
              child.type === "variable"
                ? "{{" + child.attrs.id + "}}"
                : child.text || "",
            )
            .join("")
        : renderNative({ type: "doc", content: [node] }),
    )
    .join("");
}
