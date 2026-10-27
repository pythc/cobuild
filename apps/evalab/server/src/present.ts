import type { Pool, PoolClient } from 'pg';
import { displayManifest, type MaterialManifest } from './materials.js';

export type Direction = 'PRODUCT' | 'DEVELOPMENT_TEST';
export type Audience = 'candidate' | 'admin';
export type ExamState = 'READY' | 'ACTIVE' | 'FINALIZED' | 'EXPIRED';

export type Enrollment = {
  id: string;
  roundId: string;
  batchId: string;
  batchName: string;
  roundName: string;
  direction: Direction;
  state: ExamState;
  mcpConnected: boolean;
  consentAccepted: boolean;
  directUploadAccepted: boolean;
  materialUpload?: { id: string; status: string; totalBytes: number; receivedBytes: number; expiresAt: string };
  startedAt: string | null;
  deadline: string | null;
  durationHours: number;
  finalizedAt: string | null;
  question: null | {
    title: string;
    content: string;
    attachments: Array<{ id: string; name: string; size: number; url: string }>;
  };
  repository: null | {
    id: string;
    url: string;
    branch: string;
    sha: string;
    message: string;
    author: string;
    committedAt: string;
    confirmedAt: string;
  };
  materials: null | {
    id: string;
    sha256: string;
    repoSha: string;
    receivedAt: string;
    clientCount: number;
    fileCount: number;
    coverage: string;
  };
  approvals: Array<{
    id: string;
    manifest: MaterialManifest;
    payloadHash: string;
    repoSha: string;
    state: string;
    expiresAt: string;
  }>;
  result: null | { score: number; feedback: string; publishedAt: string | null };
  submission?: { id: string; submittedAt: string; sha: string; materialsHash: string };
};

type Queryable = Pool | PoolClient;

type EnrollmentRow = {
  id: string;
  user_id: string;
  round_id: string;
  batch_id: string;
  batch_name: string;
  round_name: string;
  direction: Direction;
  consent_version: string | null;
  direct_upload_consent_at: Date | null;
  consent_accepted_at: Date | null;
  mcp_connected: boolean;
  started_at: Date | null;
  deadline: Date | null;
  captured_duration_hours: number | null;
  batch_duration_hours: number;
  finalized_at: Date | null;
  question_version_id: string | null;
  repository_id: string | null;
};

export async function dbNow(db: Queryable): Promise<Date> {
  const result = await db.query<{ now: Date }>('SELECT now() AS now');
  return new Date(result.rows[0]?.now ?? Date.now());
}

export function examState(row: { finalized_at: Date | null; started_at: Date | null; deadline: Date | null }, now: Date): ExamState {
  if (row.finalized_at) return 'FINALIZED';
  if (row.started_at && row.deadline && new Date(row.deadline).getTime() <= now.getTime()) return 'EXPIRED';
  if (row.started_at) return 'ACTIVE';
  return 'READY';
}

export async function presentEnrollments(db: Queryable, ids: string[], audience: Audience): Promise<Map<string, Enrollment>> {
  const out = new Map<string, Enrollment>();
  if (ids.length === 0) return out;
  const now = await dbNow(db);
  const bases = await db.query<EnrollmentRow>(
    `SELECT e.id, e.user_id, e.round_id, e.batch_id, b.name AS batch_name, r.name AS round_name,
            e.direction, e.consent_version, e.consent_accepted_at, e.direct_upload_consent_at, e.mcp_connected, e.started_at,
            e.deadline, e.duration_hours AS captured_duration_hours, b.duration_hours AS batch_duration_hours,
            e.finalized_at, e.question_version_id, e.repository_id
     FROM enrollments e
     JOIN batches b ON b.id = e.batch_id
     JOIN rounds r ON r.id = e.round_id
     WHERE e.id = ANY($1::uuid[])`,
    [ids],
  );
  const versionIds = bases.rows.map((row) => row.question_version_id).filter((id): id is string => Boolean(id));
  const versions = await db.query<{ id: string; title: string; content: string; attachment_ids: string[] }>(
    'SELECT id, title, content, attachment_ids FROM question_versions WHERE id = ANY($1::uuid[])',
    [versionIds.length ? versionIds : ['00000000-0000-0000-0000-000000000000']],
  );
  const attachmentIds = [...new Set(versions.rows.flatMap((row) => row.attachment_ids ?? []))];
  const attachments = await db.query<{ id: string; original_name: string; size_bytes: number }>(
    'SELECT id, original_name, size_bytes FROM attachments WHERE id = ANY($1::uuid[])',
    [attachmentIds.length ? attachmentIds : ['00000000-0000-0000-0000-000000000000']],
  );
  const attachmentById = new Map(attachments.rows.map((row) => [row.id, row]));
  const versionById = new Map(versions.rows.map((row) => [row.id, row]));
  const repos = await db.query<{
    id: string; url: string; branch: string; sha: string; message: string; author: string;
    committed_at: Date; confirmed_at: Date;
  }>(
    `SELECT id, url, branch, sha, message, author, committed_at, confirmed_at
     FROM repositories WHERE id = ANY($1::uuid[]) AND superseded_at IS NULL`,
    [bases.rows.map((row) => row.repository_id).filter((id): id is string => Boolean(id)).concat(['00000000-0000-0000-0000-000000000000'])],
  );
  const repoById = new Map(repos.rows.map((row) => [row.id, row]));
  const materials = await db.query<{
    id: string; enrollment_id: string; sha256: string; repo_sha: string; received_at: Date;
    client_count: number; file_count: number; coverage: string; invalidated_at: Date | null;
  }>(
    `SELECT DISTINCT ON (enrollment_id) id, enrollment_id, sha256, repo_sha, received_at, client_count, file_count, coverage, invalidated_at
     FROM materials
     WHERE enrollment_id = ANY($1::uuid[]) AND invalidated_at IS NULL
     ORDER BY enrollment_id, received_at DESC`,
    [ids],
  );
  const materialByEnrollment = new Map(materials.rows.map((row) => [row.enrollment_id, row]));
  const approvals = await db.query<{
    id: string; enrollment_id: string; manifest: unknown; payload_hash: string; repo_sha: string;
    state: string; expires_at: Date; created_at: Date;
  }>(
    `SELECT id, enrollment_id, manifest, payload_hash, repo_sha, state, expires_at, created_at
     FROM material_approvals WHERE enrollment_id = ANY($1::uuid[])
     ORDER BY created_at DESC`,
    [ids],
  );
  const reviews = await db.query<{ enrollment_id: string; score: number; feedback: string; published_at: Date | null }>(
    'SELECT enrollment_id, score, feedback, published_at FROM reviews WHERE enrollment_id = ANY($1::uuid[])',
    [ids],
  );
  const reviewByEnrollment = new Map(reviews.rows.map((row) => [row.enrollment_id, row]));
  const receipts = await db.query<{ enrollment_id: string; id: string; submitted_at: Date; sha: string; materials_hash: string }>(
    'SELECT enrollment_id, id, submitted_at, sha, materials_hash FROM finalize_receipts WHERE enrollment_id = ANY($1::uuid[])',
    [ids],
  );
  const receiptByEnrollment = new Map(receipts.rows.map((row) => [row.enrollment_id, row]));
  const approvalsByEnrollment = new Map<string, typeof approvals.rows>();
  for (const row of approvals.rows) {
    const list = approvalsByEnrollment.get(row.enrollment_id) ?? [];
    if (list.length < 20) list.push(row);
    approvalsByEnrollment.set(row.enrollment_id, list);
  }

  const uploads = await db.query<{id:string;enrollment_id:string;status:string;total_bytes:string;received:string;expires_at:Date}>(
    `SELECT DISTINCT ON(u.enrollment_id) u.id,u.enrollment_id,
      CASE WHEN u.expires_at<=clock_timestamp() AND u.status<>'RECEIVED' THEN 'EXPIRED' ELSE u.status END AS status,
      u.total_bytes,coalesce((SELECT sum(f.received_bytes) FROM material_upload_files f WHERE f.upload_id=u.id),0)::text AS received,u.expires_at
     FROM material_uploads u WHERE u.enrollment_id=ANY($1::uuid[]) ORDER BY u.enrollment_id,u.created_at DESC`,[ids]);
  const uploadByEnrollment = new Map(uploads.rows.map(u=>[u.enrollment_id,u]));
  for (const row of bases.rows) {
    const version = row.question_version_id ? versionById.get(row.question_version_id) : undefined;
    const question = row.started_at && version
      ? {
          title: version.title,
          content: version.content,
          attachments: (version.attachment_ids ?? []).flatMap((id) => {
            const file = attachmentById.get(id);
            return file ? [{ id: file.id, name: file.original_name, size: file.size_bytes, url: `/api/attachments/${file.id}` }] : [];
          }),
        }
      : null;
    const repo = row.repository_id ? repoById.get(row.repository_id) : undefined;
    const material = materialByEnrollment.get(row.id);
    const bound = material && repo && material.repo_sha === repo.sha ? material : null;
    const review = reviewByEnrollment.get(row.id);
    const showResult = review && (audience === 'admin' || review.published_at);
    const receipt = receiptByEnrollment.get(row.id);
    const upload = uploadByEnrollment.get(row.id);
    const enrollment: Enrollment = {
      id: row.id,
      roundId: row.round_id,
      batchId: row.batch_id,
      batchName: row.batch_name,
      roundName: row.round_name,
      direction: row.direction,
      state: examState(row, now),
      mcpConnected: row.mcp_connected,
      consentAccepted: row.consent_version === 'assessment-consent-v1' && Boolean(row.consent_accepted_at),
      directUploadAccepted: Boolean(row.direct_upload_consent_at),
      ...(upload ? {materialUpload:{id:upload.id,status:upload.status,totalBytes:Number(upload.total_bytes),receivedBytes:Number(upload.received),expiresAt:upload.expires_at.toISOString()}} : {}),
      startedAt: iso(row.started_at),
      deadline: iso(row.deadline),
      durationHours: row.started_at && row.captured_duration_hours != null ? row.captured_duration_hours : row.batch_duration_hours,
      finalizedAt: iso(row.finalized_at),
      question,
      repository: repo
        ? {
            id: repo.id,
            url: repo.url,
            branch: repo.branch,
            sha: repo.sha,
            message: repo.message,
            author: repo.author,
            committedAt: new Date(repo.committed_at).toISOString(),
            confirmedAt: new Date(repo.confirmed_at).toISOString(),
          }
        : null,
      materials: bound
        ? {
            id: bound.id,
            sha256: bound.sha256,
            repoSha: bound.repo_sha,
            receivedAt: new Date(bound.received_at).toISOString(),
            clientCount: bound.client_count,
            fileCount: bound.file_count,
            coverage: bound.coverage,
          }
        : null,
      approvals: (approvalsByEnrollment.get(row.id) ?? []).map((item) => ({
        id: item.id,
        manifest: displayManifest(item.manifest),
        payloadHash: item.payload_hash,
        repoSha: item.repo_sha,
        state: item.expires_at && new Date(item.expires_at).getTime() <= now.getTime() && (item.state === 'PENDING' || item.state === 'APPROVED')
          ? 'EXPIRED'
          : item.state,
        expiresAt: new Date(item.expires_at).toISOString(),
      })),
      result: showResult && review
        ? { score: review.score, feedback: review.feedback, publishedAt: iso(review.published_at) }
        : null,
    };
    if (receipt) {
      enrollment.submission = {
        id: receipt.id,
        submittedAt: new Date(receipt.submitted_at).toISOString(),
        sha: receipt.sha,
        materialsHash: receipt.materials_hash,
      };
    }
    out.set(row.id, enrollment);
  }
  return out;
}

function iso(value: Date | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}
