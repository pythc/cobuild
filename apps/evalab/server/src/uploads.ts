import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat, statfs, truncate } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { AppContext } from "./context.js";
import type { McpIdentity } from "./assessment.js";
import type { PublicUser } from "./auth.js";
import { asyncHandler, routeId } from "./http.js";
import { withTx } from "./db.js";
import { HttpError } from "./errors.js";
import { hashCanonical, sha256Hex } from "./security.js";
import { insertAudit } from "./audit.js";

export const MAX_MATERIAL_BYTES = 1024 ** 3;
export const CHUNK_BYTES = 4 * 1024 ** 2;
const SPARE_BYTES = 1024 ** 3;
const model = z
  .object({
    name: z.string().min(1).max(120),
    source: z.enum(["reported", "detected", "unknown"]),
    parameters: z
      .record(
        z.string().max(80),
        z.union([
          z.string().max(500),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .refine((x) => Object.keys(x).length <= 20)
      .optional(),
  })
  .strict();
export const directMetadataSchema = z
  .object({
    repoSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    clients: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            version: z.string().max(120).optional(),
            models: z.array(model).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    projectSummary: z.string().trim().min(1).max(20000),
    collaborationSummary: z.string().trim().min(1).max(20000),
  })
  .strict();
const fileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (x) => x !== "." && x !== ".." && !/[\\/:\u0000-\u001f\u007f]/.test(x),
      ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(MAX_MATERIAL_BYTES),
    source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,79}$/),
    coverage: z.enum(["export", "partial"]),
  })
  .strict();
const manifestSchema = z
  .object({ files: z.array(fileSchema).min(1).max(20) })
  .strict();
type Metadata = z.infer<typeof directMetadataSchema>;
type FileMeta = z.infer<typeof fileSchema>;
type Upload = {
  id: string;
  enrollment_id: string;
  user_id: string;
  mcp_token_id: string;
  repo_sha: string;
  metadata: Metadata;
  manifest: { files: FileMeta[] } | null;
  status: string;
  total_bytes: string;
  material_id: string | null;
  expires_at: Date;
};
type UploadFile = {
  id: string;
  name: string;
  sha256: string;
  size_bytes: string;
  received_bytes: string;
};
function root(ctx: AppContext) {
  return path.join(ctx.config.storageDir, "materials");
}
function filePath(ctx: AppContext, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid storage identifier");
  return path.join(root(ctx), id);
}
function invalid(
  message: string,
  code = "UPLOAD_INVALID",
  status = 409,
): never {
  throw new HttpError(status, message, code);
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const out = schema.safeParse(body);
  if (!out.success) invalid("上传信息格式不正确", "VALIDATION", 400);
  return out.data;
}
function bearer(req: Request): string {
  const m = /^Bearer (lu_[A-Za-z0-9_-]{43})$/.exec(
    req.header("authorization") ?? "",
  );
  if (!m) invalid("上传凭证无效", "UNAUTHENTICATED", 401);
  return m[1]!;
}
async function lockUpload(client: PoolClient, id: string) {
  const r = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok",
    ["material-upload:" + id],
  );
  if (!r.rows[0]?.ok) invalid("此上传正在处理，请稍后重试", "UPLOAD_BUSY");
}
async function authorize(
  client: PoolClient,
  id: string,
  token: string,
  requireWritable = true,
): Promise<Upload> {
  const r = await client.query<
    Upload & {
      valid: boolean;
      active: boolean;
      current_sha: string | null;
      direct_consent: boolean;
    }
  >(
    `SELECT u.*,e.user_id,
 (u.expires_at>clock_timestamp() AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()) AS valid,
 (e.started_at IS NOT NULL AND e.deadline>clock_timestamp() AND e.finalized_at IS NULL) AS active,
 e.direct_upload_consent_at IS NOT NULL AS direct_consent,r.sha AS current_sha
 FROM material_uploads u JOIN mcp_tokens t ON t.id=u.mcp_token_id JOIN enrollments e ON e.id=u.enrollment_id
 LEFT JOIN repositories r ON r.id=e.repository_id WHERE u.id=$1 AND u.token_hash=$2 FOR UPDATE OF u`,
    [id, sha256Hex(token)],
  );
  const row = r.rows[0];
  if (!row?.valid)
    invalid(
      "上传凭证已失效，请重新调用 submit_materials",
      "UNAUTHENTICATED",
      401,
    );
  if (!row.direct_consent)
    invalid("请先在考核页面同意直接上传材料说明", "CONSENT_REQUIRED");
  if (requireWritable && !row.active)
    invalid("考核未开始、已截止或已交卷，不能上传", "EXAM_UNAVAILABLE");
  if (row.current_sha !== row.repo_sha)
    invalid("仓库版本已变更，请重新提交材料", "REPOSITORY_CHANGED");
  if (["SUPERSEDED", "EXPIRED"].includes(row.status))
    invalid("上传已失效，请重新调用 submit_materials", "UPLOAD_EXPIRED");
  return row;
}
async function filesOf(client: PoolClient, id: string) {
  return (
    await client.query<UploadFile>(
      "SELECT id,name,sha256,size_bytes,received_bytes FROM material_upload_files WHERE upload_id=$1 ORDER BY name",
      [id],
    )
  ).rows;
}
async function receiptOf(client: PoolClient, id: string | null) {
  if (!id) return undefined;
  const r = await client.query<{
    id: string;
    sha256: string;
    repo_sha: string;
    received_at: Date;
  }>("SELECT id,sha256,repo_sha,received_at FROM materials WHERE id=$1", [id]);
  const v = r.rows[0];
  return v
    ? {
        id: v.id,
        sha256: v.sha256,
        repoSha: v.repo_sha,
        receivedAt: v.received_at.toISOString(),
      }
    : undefined;
}
async function view(client: PoolClient, row: Upload) {
  return {
    uploadId: row.id,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    files: (await filesOf(client, row.id)).map((f) => ({
      id: f.id,
      name: f.name,
      sha256: f.sha256,
      bytes: Number(f.size_bytes),
      receivedBytes: Number(f.received_bytes),
    })),
    receipt: await receiptOf(client, row.material_id),
  };
}

export async function createMaterialUpload(
  ctx: AppContext,
  identity: McpIdentity,
  input: unknown,
) {
  const metadata = parse(directMetadataSchema, input);
  if (!identity.mcpTokenId)
    invalid("需要已认证的 MCP 连接", "UNAUTHENTICATED", 401);
  return withTx(ctx.pool, async (client) => {
    const e = (
      await client.query<{
        user_id: string;
        ok: boolean;
        consent: boolean;
        sha: string | null;
        deadline: Date;
      }>(
        `SELECT e.user_id,
 (e.started_at IS NOT NULL AND e.deadline>clock_timestamp() AND e.finalized_at IS NULL) AS ok,
 e.direct_upload_consent_at IS NOT NULL AS consent,r.sha,e.deadline
 FROM enrollments e LEFT JOIN repositories r ON r.id=e.repository_id WHERE e.id=$1 FOR UPDATE OF e`,
        [identity.enrollmentId],
      )
    ).rows[0];
    if (!e || e.user_id !== identity.userId)
      invalid("未找到考核", "NOT_FOUND", 404);
    if (!e.ok) invalid("只能在考核进行中提交材料", "EXAM_UNAVAILABLE");
    if (!e.consent)
      invalid(
        "请在考核页面同意一次新版材料说明，然后重试。无需逐份批准。",
        "CONSENT_REQUIRED",
      );
    if (!e.sha || e.sha !== metadata.repoSha)
      invalid("请先在网页确认相同版本的仓库", "REPOSITORY_CHANGED");
    const t = await client.query(
      "SELECT 1 FROM mcp_tokens WHERE id=$1 AND enrollment_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
      [identity.mcpTokenId, identity.enrollmentId],
    );
    if (!t.rowCount) invalid("MCP 连接已失效", "UNAUTHENTICATED", 401);
    const recent = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM material_uploads WHERE enrollment_id=$1 AND created_at>now()-interval '10 minutes'",
      [identity.enrollmentId],
    );
    if ((recent.rows[0]?.n ?? 0) >= 20)
      invalid("上传创建过于频繁，请稍后重试", "RATE_LIMIT", 429);
    await client.query(
      "UPDATE material_uploads SET status='SUPERSEDED' WHERE enrollment_id=$1 AND status IN ('AWAITING_FILES','UPLOADING')",
      [identity.enrollmentId],
    );
    const token = "lu_" + randomBytes(32).toString("base64url");
    const r = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO material_uploads(enrollment_id,mcp_token_id,token_hash,repo_sha,metadata,expires_at)
  VALUES($1,$2,$3,$4,$5::jsonb,least($6::timestamptz,now()+interval '2 hours')) RETURNING id,expires_at`,
      [
        identity.enrollmentId,
        identity.mcpTokenId,
        sha256Hex(token),
        metadata.repoSha,
        JSON.stringify(metadata),
        e.deadline,
      ],
    );
    const row = r.rows[0]!;
    const uploadUrl = ctx.config.publicBaseUrl + "/material-uploads/" + row.id;
    return {
      uploadId: row.id,
      uploadUrl,
      uploadToken: token,
      expiresAt: row.expires_at.toISOString(),
      maxTotalBytes: MAX_MATERIAL_BYTES,
      chunkBytes: CHUNK_BYTES,
      helperUrl: ctx.config.publicBaseUrl + "/downloads/upload-materials.py?v=0.2.2",
      status: "AWAITING_FILES",
      message:
        "用下载的 Python 上传程序读取指定文件并传输；不要将文件全文放进模型上下文或工具参数。收到回执后，考生在网页确认交卷。",
    };
  });
}

async function setManifest(
  ctx: AppContext,
  id: string,
  token: string,
  input: unknown,
) {
  const manifest = parse(manifestSchema, input);
  const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_MATERIAL_BYTES)
    invalid("材料总大小不能超过 1 GB", "TOO_LARGE", 413);
  if (new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length)
    invalid("文件名不能重复", "VALIDATION", 400);
  await mkdir(root(ctx), { recursive: true, mode: 0o700 });
  return withTx(ctx.pool, async (client) => {
    await lockUpload(client, id);
    const row = await authorize(client, id, token);
    if (row.manifest) {
      if (hashCanonical(row.manifest) !== hashCanonical(manifest))
        invalid("同一上传不能更换文件；请创建新上传");
      return view(client, row);
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('material-storage-reservations',0))",
    );
    const reserved = await client.query<{
      bytes: string;
    }>(`SELECT coalesce(sum(f.size_bytes-f.received_bytes),0)::text AS bytes FROM material_upload_files f
  JOIN material_uploads u ON u.id=f.upload_id WHERE u.status IN ('AWAITING_FILES','UPLOADING') AND u.expires_at>clock_timestamp()`);
    const disk = await statfs(root(ctx));
    if (
      disk.bavail * disk.bsize <
      Number(reserved.rows[0]?.bytes ?? 0) + total + SPARE_BYTES
    )
      invalid("服务器存储空间不足，请联系管理员", "STORAGE_FULL", 507);
    for (const f of manifest.files)
      await client.query(
        "INSERT INTO material_upload_files(upload_id,name,sha256,size_bytes) VALUES($1,$2,$3,$4)",
        [id, f.name, f.sha256, f.bytes],
      );
    await client.query(
      "UPDATE material_uploads SET manifest=$2::jsonb,total_bytes=$3,status='UPLOADING' WHERE id=$1",
      [id, JSON.stringify(manifest), total],
    );
    row.manifest = manifest;
    row.status = "UPLOADING";
    return view(client, row);
  });
}

let activeStreams = 0;
async function uploadChunk(
  ctx: AppContext,
  id: string,
  fileId: string,
  token: string,
  req: Request,
) {
  const offsetText = String(req.query.offset ?? "");
  const lengthText = req.header("content-length") ?? "";
  if (!/^\d+$/.test(offsetText) || !/^\d+$/.test(lengthText))
    invalid("需要有效的偏移与 Content-Length", "VALIDATION", 400);
  const offset = Number(offsetText),
    length = Number(lengthText);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > CHUNK_BYTES
  )
    invalid("每块最大 4 MB", "TOO_LARGE", 413);
  if (activeStreams >= 2)
    invalid("上传通道繁忙，请稍后重试", "UPLOAD_BUSY", 429);
  activeStreams++;
  try {
    return await withTx(ctx.pool, async (client) => {
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout='120s'",
      );
      await lockUpload(client, id);
      const row = await authorize(client, id, token);
      if (row.status !== "UPLOADING")
        invalid("请先提交文件清单", "MANIFEST_REQUIRED");
      const f = (
        await client.query<UploadFile>(
          "SELECT id,name,sha256,size_bytes,received_bytes FROM material_upload_files WHERE upload_id=$1 AND id=$2",
          [id, fileId],
        )
      ).rows[0];
      if (!f) invalid("未找到上传文件", "NOT_FOUND", 404);
      if (Number(f.received_bytes) !== offset)
        invalid("偏移已变化，请查询上传进度后续传", "OFFSET_MISMATCH");
      if (offset + length > Number(f.size_bytes))
        invalid("分块超出文件大小", "TOO_LARGE", 413);
      const target = filePath(ctx, fileId);
      await mkdir(root(ctx), { recursive: true, mode: 0o700 });
      const handle = await open(target, "a", 0o600);
      await handle.close();
      // Crash recovery: only committed bytes count, discard any incomplete tail.
      await truncate(target, offset);
      let written = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          written += chunk.length;
          cb(
            written > length ? new Error("Chunk length exceeded") : null,
            chunk,
          );
        },
      });
      const timeout = setTimeout(
        () => req.destroy(new Error("Upload timeout")),
        60_000,
      );
      timeout.unref();
      try {
        await pipeline(
          req,
          meter,
          createWriteStream(target, { flags: "r+", start: offset }),
        );
        if (written !== length)
          invalid("分块未完整收到，请重试", "INCOMPLETE_CHUNK", 400);
        await authorize(client, id, token);
        const saved = await open(target, "r");
        try {
          await saved.sync();
        } finally {
          await saved.close();
        }
        await client.query(
          "UPDATE material_upload_files SET received_bytes=$2 WHERE id=$1",
          [fileId, offset + length],
        );
        return { receivedBytes: offset + length };
      } catch (error) {
        await truncate(target, offset).catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  } finally {
    activeStreams--;
  }
}
async function digestFile(filename: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(filename)) h.update(chunk);
  return h.digest("hex");
}
async function complete(ctx: AppContext, id: string, token: string) {
  return withTx(ctx.pool, async (client) => {
    await client.query("SET LOCAL idle_in_transaction_session_timeout='120s'");
    // Keep lock order enrollment -> upload to serialize repository replacement/finalization.
    const owner = await client.query<{ enrollment_id: string }>(
      "SELECT enrollment_id FROM material_uploads WHERE id=$1 AND token_hash=$2",
      [id, sha256Hex(token)],
    );
    if (!owner.rows[0]) invalid("上传凭证无效", "UNAUTHENTICATED", 401);
    await client.query("SELECT id FROM enrollments WHERE id=$1 FOR UPDATE", [
      owner.rows[0].enrollment_id,
    ]);
    await lockUpload(client, id);
    const row = await authorize(client, id, token, false);
    if (row.status === "RECEIVED")
      return {
        receipt: await receiptOf(client, row.material_id),
        status: "RECEIVED",
      };
    await authorize(client, id, token);
    const files = await filesOf(client, id);
    if (!row.manifest || files.length !== row.manifest.files.length)
      invalid("尚未上传文件", "INCOMPLETE_UPLOAD");
    for (const f of files) {
      if (Number(f.received_bytes) !== Number(f.size_bytes))
        invalid("还有文件尚未传完", "INCOMPLETE_UPLOAD");
      const target = filePath(ctx, f.id);
      if (
        (await stat(target)).size !== Number(f.size_bytes) ||
        (await digestFile(target)) !== f.sha256
      )
        invalid("文件校验失败，请重新创建上传并重试", "HASH_MISMATCH");
    }
    // Digest covers the actual verified file hashes and immutable repository binding, not model-retyped JSON.
    const { repoSha, ...metadata } = row.metadata;
    const manifest = { ...metadata, files: row.manifest.files };
    const payload = {
      schemaVersion: 2,
      repoSha,
      manifest,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        bytes: Number(f.size_bytes),
        sha256: f.sha256,
      })),
    };
    const hash = hashCanonical({ schemaVersion: 2, repoSha, manifest });
    const kinds = new Set(row.manifest.files.map((f) => f.coverage));
    await authorize(client, id, token);
    const r = await client.query<{ id: string }>(
      `INSERT INTO materials(enrollment_id,sha256,repo_sha,payload,client_count,file_count,coverage)
  VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id`,
      [
        row.enrollment_id,
        hash,
        repoSha,
        JSON.stringify(payload),
        metadata.clients.length,
        files.length,
        kinds.size === 1 ? row.manifest.files[0]!.coverage : "mixed",
      ],
    );
    const materialId = r.rows[0]!.id;
    await client.query(
      "UPDATE materials SET invalidated_at=clock_timestamp() WHERE enrollment_id=$1 AND id<>$2 AND invalidated_at IS NULL",
      [row.enrollment_id, materialId],
    );
    await client.query(
      "UPDATE material_uploads SET material_id=$2,status='RECEIVED' WHERE id=$1",
      [id, materialId],
    );
    await insertAudit(client, {
      actorId: row.user_id,
      actorName: "candidate",
      action: "MATERIALS_DIRECT_RECEIVED",
      enrollmentId: row.enrollment_id,
      details: {
        materialId,
        fileCount: files.length,
        totalBytes: Number(row.total_bytes),
      },
    });
    return { receipt: await receiptOf(client, materialId), status: "RECEIVED" };
  });
}

export function registerMaterialUploads(app: Express, ctx: AppContext) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (req.header("origin") && req.header("origin") !== ctx.config.appOrigin) {
      res.status(403).json({ message: "请求来源不被允许" });
      return;
    }
    next();
  });
  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = routeId(req.params.id),
        token = bearer(req);
      res.json(
        await withTx(ctx.pool, async (client) =>
          view(client, await authorize(client, id, token, false)),
        ),
      );
    }),
  );
  router.post(
    "/:id/manifest",
    express.json({ limit: "256kb" }),
    asyncHandler(async (req, res) => {
      res.json(
        await setManifest(ctx, routeId(req.params.id), bearer(req), req.body),
      );
    }),
  );
  router.put(
    "/:id/files/:fileId",
    asyncHandler(async (req, res) => {
      res.json(
        await uploadChunk(
          ctx,
          routeId(req.params.id),
          routeId(req.params.fileId),
          bearer(req),
          req,
        ),
      );
    }),
  );
  router.post(
    "/:id/complete",
    express.json({ limit: "1kb" }),
    asyncHandler(async (req, res) => {
      res.json(await complete(ctx, routeId(req.params.id), bearer(req)));
    }),
  );
  router.use((_req, res) =>
    res.status(404).json({ message: "上传接口不存在" }),
  );
  app.use("/material-uploads", router);
}

export async function downloadMaterialFile(
  ctx: AppContext,
  user: PublicUser,
  enrollmentId: string,
  fileId: string,
  res: Response,
  next: NextFunction,
) {
  if (user.role !== "ADMIN") invalid("仅管理员可查看材料", "FORBIDDEN", 403);
  const r = await ctx.pool.query<{ name: string }>(
    `SELECT f.name FROM material_upload_files f JOIN material_uploads u ON u.id=f.upload_id
 JOIN materials m ON m.id=u.material_id JOIN enrollments e ON e.id=u.enrollment_id
 WHERE f.id=$1 AND e.id=$2 AND m.purged_at IS NULL AND f.deleted_at IS NULL AND u.status='RECEIVED'`,
    [fileId, enrollmentId],
  );
  if (!r.rows[0]) invalid("未找到文件", "NOT_FOUND", 404);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.download(filePath(ctx, fileId), r.rows[0].name, (error) => {
    if (error) next(error);
  });
}

export async function purgeUploadFiles(ctx: AppContext) {
  const ids = await ctx.pool.query<{
    id: string;
  }>(`SELECT DISTINCT u.id FROM material_uploads u LEFT JOIN materials m ON m.id=u.material_id
 JOIN material_upload_files f ON f.upload_id=u.id AND f.deleted_at IS NULL
 WHERE (m.purged_at IS NOT NULL OR m.invalidated_at IS NOT NULL) OR (u.status<>'RECEIVED' AND (u.expires_at<clock_timestamp() OR u.status IN ('SUPERSEDED','EXPIRED'))) LIMIT 30`);
  for (const { id } of ids.rows)
    await withTx(ctx.pool, async (client) => {
      const lock = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok",
        ["material-upload:" + id],
      );
      if (!lock.rows[0]?.ok) return;
      const valid = await client.query(
        `SELECT u.id FROM material_uploads u LEFT JOIN materials m ON m.id=u.material_id
   WHERE u.id=$1 AND ((m.purged_at IS NOT NULL OR m.invalidated_at IS NOT NULL) OR (u.status<>'RECEIVED' AND (u.expires_at<clock_timestamp() OR u.status IN ('SUPERSEDED','EXPIRED'))))`,
        [id],
      );
      if (!valid.rowCount) return;
      const files = await filesOf(client, id);
      for (const f of files) {
        await rm(filePath(ctx, f.id), { force: true });
        await client.query(
          "UPDATE material_upload_files SET deleted_at=clock_timestamp() WHERE id=$1",
          [f.id],
        );
      }
      await client.query(
        "UPDATE material_uploads SET metadata='{}'::jsonb,manifest=NULL,status=CASE WHEN status='RECEIVED' THEN status ELSE 'EXPIRED' END WHERE id=$1",
        [id],
      );
    });
  await ctx.pool
    .query(`UPDATE material_uploads u SET metadata='{}'::jsonb,manifest=NULL,status='EXPIRED'
    WHERE u.status<>'RECEIVED' AND (u.expires_at<clock_timestamp() OR u.status IN ('SUPERSEDED','EXPIRED'))
    AND NOT EXISTS(SELECT 1 FROM material_upload_files f WHERE f.upload_id=u.id AND f.deleted_at IS NULL)`);
}
