export { mailPreview } from "./recruitment-mail-editor-legacy.js";
export function mailEditor(
  session,
  template,
  container,
  onError,
  onChange = () => {},
) {
  let disposed = false,
    disabled = false,
    editor = null,
    failure = null;
  import("./recruitment-maily-editor.js")
    .then((module) => {
      if (disposed) return;
      editor = module.mailEditor(
        session,
        template,
        container,
        onError,
        onChange,
      );
      editor.setDisabled(disabled);
    })
    .catch((e) => {
      failure = e;
      if (!disposed) onError("邮件编辑器加载失败，请刷新重试");
    });
  return {
    snapshot() {
      return editor?.snapshot?.();
    },
    destroy() {
      disposed = true;
      editor?.destroy();
    },
    setDisabled(value) {
      disabled = value;
      editor?.setDisabled(value);
    },
    insertVariable(key) {
      editor?.insertVariable(key);
    },
    get pending() {
      return (!failure && !editor) || !!editor?.pending;
    },
    value() {
      if (failure) throw Error("邮件编辑器加载失败，请刷新重试");
      if (!editor) throw Error("请等待编辑器加载和图片上传完成");
      return editor.value();
    },
  };
}
