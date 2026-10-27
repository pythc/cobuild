import { newMailTemplate } from "./recruitment-mail-presets.js";
import { mailEditor, mailPreview } from "./recruitment-mail-editor.js";
import { templateKinds, variableNames } from "./recruitment-tasks.js";
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
export function createTemplateWorkspace({
  session,
  root,
  onStatus = () => {},
}) {
  let templates = [],
    current = null,
    editor = null,
    dirty = false,
    busy = false,
    disposed = false,
    generation = 0,
    previewGeneration = 0,
    timer = null,
    request = null,
    kind = "all",
    search = "",
    controls = {},
    variables = [],
    lastField = "body",
    subjectSelection = { start: 0, end: 0 },
    mode = "edit";
  root.classList.add("hf-templates");
  const button = (text, fn, cls = "rt-button") => {
    const b = el("button", text, cls);
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const heading = el("div", undefined, "rw-page-heading hf-template-heading"),
    title = el("div");
  title.append(
    el("h2", "邮件模板"),
    el("span", "模板库", "hf-template-caption"),
  );
  heading.append(title, button("＋ 新建模板", openNew, "rt-button rt-primary"));
  const layout = el("div", undefined, "hf-template-layout"),
    sidebar = el("aside", undefined, "hf-template-sidebar"),
    main = el("div", undefined, "hf-template-main");
  root.replaceChildren(heading, layout);
  layout.append(sidebar, main);
  const changed = () => {
    dirty = true;
    request = null;
    queuePreview();
    updateSavedState();
  };
  function updateSavedState() {
    if (controls.saved) {
      controls.saved.textContent = busy
        ? "正在保存…"
        : dirty
          ? "未保存"
          : "已保存";
      controls.saved.dataset.dirty = String(dirty);
    }
  }
  function payload() {
    if (!current || editor.pending)
      throw Error("请等待编辑器加载和图片上传完成");
    return {
      id: current.id,
      revision: current.revision,
      name: controls.name.value.trim(),
      kind: controls.kind.value,
      subject: controls.subject.value.trim(),
      ...editor.value(),
      editorDocument: editor.snapshot(),
      variables: variables.map((v) => ({
        key: v.key.value.trim(),
        label: v.label.value.trim(),
        defaultValue: v.defaultValue.value,
        required: v.required.checked,
      })),
    };
  }
  async function load() {
    const gen = ++generation;
    try {
      const result = await session.request("templates");
      if (disposed || gen !== generation) return;
      templates = result.items;
      renderSidebar();
      if (templates.length) render(templates[0]);
      else main.append(el("p", "新建一份邮件模板", "hf-template-empty"));
    } catch (e) {
      onStatus(e.message, true);
    }
  }
  function mayLeave() {
    return (
      !busy &&
      ((!dirty && !editor?.pending) ||
        confirm("模板尚未保存，切换会放弃当前修改。继续？"))
    );
  }
  function renderSidebar() {
    sidebar.replaceChildren();
    const filter = el("select");
    filter.setAttribute("aria-label", "按模板用途筛选");
    filter.append(
      new Option("全部用途", "all"),
      ...Object.entries(templateKinds).map(([k, v]) => new Option(v, k)),
    );
    filter.value = kind;
    filter.onchange = () => {
      kind = filter.value;
      renderList();
    };
    const input = el("input");
    input.type = "search";
    input.placeholder = "搜索模板";
    input.setAttribute("aria-label", "搜索模板");
    input.value = search;
    input.oninput = () => {
      search = input.value;
      renderList();
    };
    controls.list = el("div", undefined, "hf-template-list");
    sidebar.append(input, filter, controls.list);
    renderList();
  }
  function renderList() {
    const list = sidebar.querySelector(".hf-template-list");
    if (!list) return;
    list.replaceChildren();
    const shown = templates.filter(
      (t) =>
        (kind === "all" || (t.kind || "interview") === kind) &&
        t.name.toLowerCase().includes(search.toLowerCase()),
    );
    for (const t of shown) {
      const b = button(
        "",
        () => {
          if (mayLeave()) render(t);
        },
        "hf-template-item",
      );
      b.append(
        el("span", "✉", "hf-template-icon"),
        el("strong", t.name),
        el("small", templateKinds[t.kind || "interview"]),
      );
      b.setAttribute("aria-current", String(current?.id === t.id));
      list.append(b);
    }
    if (!shown.length) list.append(el("p", "没有匹配的模板", "rt-help"));
  }
  function openNew() {
    if (!mayLeave()) return;
    const picker = el("dialog", undefined, "rw-mail-dialog hf-template-picker");
    picker.setAttribute("aria-label", "选择模板用途");
    picker.append(el("h3", "新建邮件模板"));
    const list = el("div", undefined, "rw-preset-grid");
    for (const [k, v] of Object.entries(templateKinds))
      list.append(
        button(v, () => {
          picker.close();
          picker.remove();
          render(newMailTemplate(k));
          dirty = true;
          updateSavedState();
        }),
      );
    picker.append(
      list,
      button("取消", () => {
        picker.close();
        picker.remove();
      }),
    );
    picker.addEventListener("close", () => picker.remove());
    root.append(picker);
    picker.showModal();
  }
  function setMode(next) {
    mode = next;
    controls.stage.dataset.mode = mode;
    for (const b of controls.modes)
      b.setAttribute("aria-selected", String(b.dataset.mode === mode));
    if (mode === "preview") queuePreview(0);
  }
  function render(template) {
    previewGeneration++;
    clearTimeout(timer);
    editor?.destroy();
    current = { id: template.id, revision: template.revision };
    dirty = false;
    request = null;
    main.replaceChildren();
    controls = {};
    variables = [];
    const form = el("form", undefined, "hf-template-form");
    main.append(form);
    const top = el("header", undefined, "hf-template-top"),
      identity = el("div", undefined, "hf-template-identity");
    controls.title = el("h3", template.name);
    controls.saved = el("span", "已保存", "hf-save-state");
    identity.append(controls.title, controls.saved);
    const actions = el("div", undefined, "hf-template-actions");
    if (
      template.revision > 0 &&
      (!template.editorDocument ||
        template.editorDocument.content?.some(
          (n) => n.type === "htmlCodeBlock",
        ))
    )
      actions.append(
        button("原版对照", () => original(template), "rt-button hf-quiet"),
      );
    controls.save = el("button", "保存模板", "rt-button rt-primary");
    controls.save.type = "submit";
    actions.append(controls.save);
    top.append(identity, actions);
    form.append(top);
    controls.error = el("p", undefined, "rt-form-error hf-template-error");
    controls.error.setAttribute("role", "alert");
    controls.error.hidden = true;
    form.append(controls.error);
    const workspace = el("div", undefined, "hf-template-workspace"),
      stage = el("section", undefined, "hf-template-stage"),
      rail = el("aside", undefined, "hf-template-properties");
    controls.stage = stage;
    workspace.append(stage, rail);
    form.append(workspace);
    const stageHead = el("div", undefined, "hf-template-stage-head"),
      tabs = el("div", undefined, "hf-template-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "模板画布");
    controls.modes = [];
    for (const [key, label] of [
      ["edit", "编辑"],
      ["preview", "预览"],
    ]) {
      const b = button(label, () => setMode(key));
      b.dataset.mode = key;
      b.setAttribute("role", "tab");
      controls.modes.push(b);
      tabs.append(b);
    }
    stageHead.append(tabs, el("span", "MAIL CANVAS", "hf-canvas-label"));
    stage.append(stageHead);
    const editing = el("section", undefined, "hf-template-editing"),
      preview = el("section", undefined, "hf-template-preview");
    stage.append(editing, preview);
    const body = el("div", undefined, "rw-editor-container");
    body.addEventListener("pointerdown", () => {
      lastField = "body";
    });
    body.addEventListener("focusin", (e) => {
      if (e.target.isContentEditable) lastField = "body";
    });
    editing.append(body);
    editor = mailEditor(session, template, body, error, changed);
    controls.previewStatus = el("p", "正在生成预览", "rt-help");
    controls.previewSubject = el("h4");
    controls.preview = el("div");
    preview.append(
      controls.previewStatus,
      controls.previewSubject,
      controls.preview,
    );
    rail.append(el("h4", "模板设置", "hf-property-heading"));
    const field = (key, label, type, value, required = true) => {
      const wrap = el("label", undefined, "rt-field"),
        input = el(type === "select" ? "select" : "input");
      input.name = key;
      if (type !== "select") input.type = type;
      input.required = required;
      wrap.append(el("span", label), input);
      controls[key] = input;
      input.value = value || "";
      return wrap;
    };
    rail.append(
      field("name", "模板名称", "text", template.name),
      field("kind", "用途", "select"),
      field("subject", "邮件主题", "text", template.subject),
    );
    controls.name.maxLength = 80;
    controls.kind.append(
      ...Object.entries(templateKinds).map(([k, v]) => new Option(v, k)),
    );
    controls.kind.value = template.kind || "interview";
    controls.subject.maxLength = 180;
    controls.subject.onfocus = () => {
      lastField = "subject";
    };
    for (const name of ["keyup", "mouseup", "blur"])
      controls.subject.addEventListener(
        name,
        () =>
          (subjectSelection = {
            start: controls.subject.selectionStart || 0,
            end: controls.subject.selectionEnd || 0,
          }),
      );
    const variableSection = el("section", undefined, "hf-property-section");
    variableSection.append(el("h4", "插入变量", "hf-property-heading"));
    controls.variableButtons = el("div", undefined, "hf-variable-chips");
    variableSection.append(controls.variableButtons);
    rail.append(variableSection);
    const config = el("details", undefined, "rw-variable-config");
    config.append(el("summary", "自定义变量"));
    controls.variables = el("div");
    config.append(
      controls.variables,
      button("＋ 添加变量", () => {
        if (variables.length >= 20) return;
        let n = 1;
        const keys = variables.map((v) => v.key.value);
        while (keys.includes("field" + n)) n++;
        addVariable({
          key: "field" + n,
          label: "新的字段",
          defaultValue: "",
          required: true,
        });
        changed();
      }),
    );
    rail.append(config);
    for (const v of template.variables || []) addVariable(v);
    renderVariables();
    const samples = el("details", undefined, "rw-template-samples");
    samples.append(el("summary", "预览示例资料"));
    samples.append(
      field("sampleName", "候选人姓名", "text", "林同学", false),
      field("sampleGroup", "应聘组别", "text", "开发组", false),
    );
    controls.sampleName.maxLength = 80;
    controls.sampleGroup.maxLength = 60;
    rail.append(samples);
    form.addEventListener("input", (e) => {
      if (e.target === controls.sampleName || e.target === controls.sampleGroup)
        queuePreview();
      else if (!e.target.closest(".hf-maily")) {
        if (e.target === controls.name)
          controls.title.textContent = controls.name.value;
        changed();
      }
    });
    form.addEventListener("change", (e) => {
      if (
        e.target !== controls.sampleName &&
        e.target !== controls.sampleGroup &&
        !e.target.closest(".hf-maily")
      ) {
        changed();
        renderVariables();
      }
    });
    form.onsubmit = save;
    renderSidebar();
    setMode(mode);
    queuePreview(0);
  }
  function error(message) {
    if (!controls.error) return;
    controls.error.hidden = false;
    controls.error.textContent = message;
  }
  function addVariable(value) {
    const row = el("div", undefined, "hf-custom-variable"),
      v = {};
    for (const [key, label] of [
      ["label", "字段名称"],
      ["defaultValue", "默认值"],
      ["key", "变量标识"],
    ]) {
      const labelNode = el("label", undefined, "rt-field"),
        input = el("input");
      input.type = "text";
      input.value = value[key];
      input.maxLength = key === "defaultValue" ? 500 : key === "key" ? 40 : 60;
      input.required = key !== "defaultValue";
      labelNode.append(el("span", label), input);
      row.append(labelNode);
      v[key] = input;
    }
    const required = el("label", undefined, "rt-checkbox");
    v.required = el("input");
    v.required.type = "checkbox";
    v.required.checked = value.required;
    required.append(v.required, el("span", "发送时必填"));
    row.append(
      required,
      button(
        "移除",
        () => {
          variables = variables.filter((x) => x !== v);
          row.remove();
          changed();
          renderVariables();
        },
        "rt-button hf-quiet",
      ),
    );
    variables.push(v);
    controls.variables.append(row);
    renderVariables();
  }
  function insertVariable(key) {
    if (lastField === "subject") {
      const input = controls.subject,
        { start, end } = subjectSelection;
      input.value =
        input.value.slice(0, start) +
        "{{" +
        key +
        "}}" +
        input.value.slice(end);
      subjectSelection = {
        start: start + key.length + 4,
        end: start + key.length + 4,
      };
      input.focus();
      input.setSelectionRange(subjectSelection.start, subjectSelection.end);
      changed();
    } else editor.insertVariable(key);
  }
  function renderVariables() {
    if (!controls.variableButtons) return;
    controls.variableButtons.replaceChildren();
    for (const [key, label] of [
      ...Object.entries(variableNames),
      ...variables
        .filter((v) => v.label.value.trim())
        .map((v) => [v.key.value, v.label.value]),
    ])
      controls.variableButtons.append(
        button(label, () => insertVariable(key), "hf-variable-chip"),
      );
  }
  function queuePreview(delay = 600) {
    clearTimeout(timer);
    if (disposed) return;
    controls.previewStatus &&
      (controls.previewStatus.textContent = "正在更新预览");
    timer = setTimeout(() => void preview(), delay);
  }
  async function preview() {
    const gen = ++previewGeneration;
    if (!editor || disposed) return;
    let template;
    try {
      template = payload();
    } catch (e) {
      if (editor.pending) {
        queuePreview();
        return;
      }
      controls.previewStatus.textContent = e.message;
      return;
    }
    try {
      const result = await session.request("templates/preview", {
        method: "POST",
        data: {
          template,
          sample: {
            name: controls.sampleName.value.trim() || "林同学",
            group: controls.sampleGroup.value.trim() || "开发组",
          },
        },
      });
      if (disposed || gen !== previewGeneration) return;
      const container = el("div");
      await mailPreview(session, result.payload, container);
      if (disposed || gen !== previewGeneration) return;
      controls.preview.replaceChildren(container);
      controls.previewSubject.textContent = result.payload.subject;
      controls.previewStatus.textContent = "示例预览 · 不发送邮件";
    } catch (e) {
      if (!disposed && gen === previewGeneration) {
        controls.preview.replaceChildren();
        controls.previewSubject.textContent = "";
        controls.previewStatus.textContent = e.message;
      }
    }
  }
  async function original(template) {
    const gen = generation;
    try {
      let source;
      try {
        source = await session.request(
          "templates/" + template.id + "/original",
        );
      } catch (e) {
        if (e.status !== 404) throw e;
        if (!template.editorDocument) source = template;
        else throw Error("此模板没有旧版原稿");
      }
      if (disposed || gen !== generation) return;
      const d = el("dialog", undefined, "rw-mail-dialog hf-original-dialog");
      d.setAttribute("aria-label", "迁移前原版模板");
      d.append(el("h3", "迁移前原版"), el("p", source.subject, "rt-help"));
      const body = el("div");
      d.append(
        body,
        button("关闭", () => {
          d.close();
          d.remove();
        }),
      );
      d.addEventListener("close", () => d.remove());
      root.append(d);
      await mailPreview(
        session,
        {
          ...source,
          imageIds: [
            ...new Set(
              [
                ...String(source.html || "").matchAll(
                  /src="cid:lab-([a-f0-9]{64})"/g,
                ),
              ].map((m) => m[1]),
            ),
          ],
        },
        body,
      );
      if (disposed) {
        d.remove();
        return;
      }
      d.showModal();
    } catch (e) {
      if (!disposed) error(e.message);
    }
  }
  function lock(value) {
    busy = value;
    editor?.setDisabled(value);
    for (const n of root.querySelectorAll("input,select,button,textarea"))
      n.disabled = value;
    updateSavedState();
  }
  async function save(e) {
    e.preventDefault();
    if (busy || !e.target.reportValidity()) return;
    let template;
    try {
      template = payload();
    } catch (e) {
      error(e.message);
      return;
    }
    const fingerprint = JSON.stringify(template);
    if (request?.fingerprint !== fingerprint)
      request = { fingerprint, id: crypto.randomUUID() };
    controls.error.hidden = true;
    lock(true);
    const gen = generation;
    try {
      const result = await session.request("templates", {
        method: "POST",
        data: { requestId: request.id, template },
      });
      if (disposed || gen !== generation) return;
      const index = templates.findIndex((t) => t.id === result.id);
      if (index < 0) templates.push(result);
      else templates[index] = result;
      dirty = false;
      lock(false);
      render(result);
      onStatus("");
    } catch (e) {
      if (!disposed)
        error(
          e.status === 409
            ? "其他管理员已更新此模板。请保留当前内容，重新打开最新版本后再编辑。"
            : e.message,
        );
    } finally {
      if (!disposed) lock(false);
    }
  }
  return {
    load,
    dirty: () => dirty || !!editor?.pending,
    busy: () => busy,
    destroy() {
      disposed = true;
      generation++;
      previewGeneration++;
      clearTimeout(timer);
      editor?.destroy();
      root.classList.remove("hf-templates");
      root.replaceChildren();
    },
  };
}
