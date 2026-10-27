import { z } from "zod";
import { validateEditorDocument } from "./recruitment-editor-document.mjs";
import { cleanMailHtml, imageIds } from "./recruitment-rich-mail.mjs";
import { directMailSchema } from "./recruitment-direct-mail.mjs";
import { templateSchema, workflowText } from "./recruitment-templates.mjs";

const draftMail = directMailSchema.safeExtend({
  to: z
    .array(
      z
        .email()
        .max(254)
        .transform((v) => v.toLowerCase()),
    )
    .max(50),
  template: templateSchema.safeExtend({
    subject: workflowText(180),
    body: workflowText(12000),
  }),
});
export function createMailDrafts({
  db,
  now,
  mutate,
  requireOperator,
  readAttachment,
  readImage,
  fail,
  audit,
}) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS mail_drafts(id TEXT PRIMARY KEY,actor TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,editor_data TEXT)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare("PRAGMA table_info(mail_drafts)")
        .all()
        .some((c) => c.name === "editor_data")
    )
      db.exec("ALTER TABLE mail_drafts ADD COLUMN editor_data TEXT");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const read = (actor, id) => {
    requireOperator(actor);
    const row = db
      .prepare("SELECT * FROM mail_drafts WHERE id=? AND actor=?")
      .get(z.uuid().parse(id), actor.subject);
    if (!row) fail(404, "草稿不存在或无访问权限");
    return { ...row, mail: JSON.parse(row.data) };
  };
  const view = (row) => ({
    ...(row.editor_data ? { editorDocument: JSON.parse(row.editor_data) } : {}),
    id: row.id,
    revision: row.revision,
    mail: row.mail,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
  return {
    mailDraftList(actor) {
      requireOperator(actor);
      return {
        items: db
          .prepare(
            "SELECT id,revision,data,created_at,updated_at FROM mail_drafts WHERE actor=? ORDER BY updated_at DESC LIMIT 100",
          )
          .all(actor.subject)
          .map((r) => ({
            id: r.id,
            revision: r.revision,
            subject: JSON.parse(r.data).template.subject,
            recipients: JSON.parse(r.data).to,
            updatedAt: new Date(r.updated_at).toISOString(),
          })),
      };
    },
    mailDraftGet(actor, id) {
      const row = read(actor, id);
      return {
        ...view(row),
        attachments: row.mail.attachments.map((id) => {
          const { buffer, ...metadata } = readAttachment(actor, id);
          return metadata;
        }),
      };
    },
    mailDraftSave(actor, raw) {
      const input = z
        .object({
          requestId: z.uuid(),
          id: z.uuid(),
          revision: z.number().int().min(0),
          mail: draftMail,
          editorDocument: z.unknown().optional(),
        })
        .strict()
        .parse(raw);
      return mutate(actor, input, "mail-draft-save", () => {
        const old = db
          .prepare("SELECT * FROM mail_drafts WHERE id=?")
          .get(input.id);
        if (
          (old &&
            (old.actor !== actor.subject || old.revision !== input.revision)) ||
          (!old && input.revision !== 0)
        )
          fail(409, "草稿已改变，请重新打开最新版本");
        if (
          !old &&
          Number(
            db
              .prepare("SELECT COUNT(*) n FROM mail_drafts WHERE actor=?")
              .get(actor.subject).n,
          ) >= 100
        )
          fail(429, "最多保留 100 封草稿，请先清理不再需要的草稿");
        const mail = {
          ...input.mail,
          template: {
            ...input.mail.template,
            html: cleanMailHtml(input.mail.template.html),
          },
        };
        for (const id of mail.attachments) readAttachment(actor, id);
        for (const id of imageIds(mail.template.html)) readImage(actor, id);
        let editorData;
        try {
          editorData = validateEditorDocument(
            input.editorDocument,
            mail.template.html,
          );
        } catch (error) {
          fail(400, error.message);
        }
        const revision = input.revision + 1,
          data = JSON.stringify(mail);
        if (
          Buffer.byteLength(data) + Buffer.byteLength(editorData || "") >
          240000
        )
          fail(413, "草稿内容过大");
        db.prepare(
          "INSERT INTO mail_drafts(id,actor,revision,data,created_at,updated_at,editor_data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,editor_data=excluded.editor_data",
        ).run(
          input.id,
          actor.subject,
          revision,
          data,
          old?.created_at || now(),
          now(),
          editorData,
        );
        audit(actor, "mail-draft-save", { id: input.id, revision });
        return view(read(actor, input.id));
      });
    },
    mailDraftDelete(actor, raw) {
      const input = z
        .object({
          requestId: z.uuid(),
          id: z.uuid(),
          revision: z.number().int().min(1),
        })
        .strict()
        .parse(raw);
      return mutate(actor, input, "mail-draft-delete", () => {
        const row = read(actor, input.id);
        if (row.revision !== input.revision)
          fail(409, "草稿已改变，请重新打开最新版本");
        db.prepare("DELETE FROM mail_drafts WHERE id=? AND actor=?").run(
          input.id,
          actor.subject,
        );
        audit(actor, "mail-draft-delete", { id: input.id });
        return { deleted: true, id: input.id };
      });
    },
  };
}
