import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';
import { diag, safeErrorText } from './diag.js';
import { uploadRawFiles } from './directUpload.js';
import { discover } from './discover.js';
import { callRemote, requestUploadTicket } from './remote.js';
import type { Candidate, MaterialClient } from './types.js';
import { BRIDGE_VERSION } from './version.js';

export const BRIDGE_INSTRUCTIONS = [
  "You are assisting a candidate in the 110 Laboratory recruitment assessment for Chongqing University of Posts and Telecommunications students. The candidate uses a self-chosen coding Agent to build a real project in the product or development/testing track. The assessment reviews the submitted repository version together with the candidate's Agent-assisted project work. The attempt duration is configured per batch and captured when the candidate starts it. Use exam_status for the candidate's personal deadline; the batch's latest-start time does not end an already started attempt.",
  "This local bridge is scoped to the configured exam workspace and explicitly authorized context roots. It does not upload anything on initialization and cannot read arbitrary home-directory contents. Call test_connection for preflight and exam_status for the actual enrollment, deadline, confirmed repository SHA, consent and receipt.",
  "When the candidate asks to submit materials, the required material is the CURRENT CONVERSATION'S ORIGINAL RAW LOG FILE from the CURRENT AGENT CLIENT for this assessment project. Identify it from the client's current session id, log path or session-index metadata. Include additional raw log segments only when they belong to that same conversation. Matching a workspace alone does not establish that a file belongs to the current conversation. Do not substitute other sessions, other clients, reconstructed transcripts, summaries or converted exports.",
  "After exam_status confirms the required consent, an active attempt and the confirmed repository SHA, proceed directly within the client's existing file permissions. Do not ask additional questions, request another upload approval, or ask the candidate to select files or repeat client/model/project details that are already available. Briefly state that the current-session raw log is being uploaded; this is a notice, not a confirmation gate. Do not conceal the upload. Missing consent, permissions, repository confirmation or an unidentifiable/unavailable raw log is a blocker: report it accurately, without bypassing it, uploading another conversation, or claiming completion.",
  "Use find_candidate_files with explicitPaths pointing to the current client's current-session raw log files whenever those paths are known. The tool returns candidate metadata only; it may list other sessions from the same workspace, so include only ids verified to belong to the current conversation. Do not load log bodies into model context. If the raw log cannot be identified or lies outside authorized roots, report the blocker and do not substitute a different file.",
  "Call submit_files with those fileIds, the confirmed repoSha, client/model metadata and brief project/collaboration summaries derived from the already-visible conversation. Unknown client/model values must be reported as unknown. No further file-selection or upload-confirmation questions are needed after the candidate's recorded consent and submission request. Tell the user the upload is happening. Do not conceal it.",
  "submit_files captures a byte-for-byte snapshot before transferring a still-growing log. The original file is not modified. Only entries appended after the snapshot begins are outside that captured version; no captured bytes are filtered, redacted, trimmed, converted or reconstructed. Hashes and file bodies are handled programmatically, never embedded in tool arguments. The combined limit is 1 GiB and at most 20 files.",
  "After upload, use exam_status to verify the receipt and repository SHA. Summaries cannot replace original logs. This bridge cannot finalize the exam; the candidate must click 确认交卷 on the website.",
].join(' ');

const parameterSchema = z.record(
  z.string().min(1).max(80),
  z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
).refine((value) => Object.keys(value).length <= 20, 'too many parameters');

const declaredClientSchema = z.object({
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(120).optional(),
  models: z.array(z.object({
    name: z.string().min(1).max(120),
    parameters: parameterSchema.optional(),
    source: z.enum(['reported', 'detected', 'unknown']),
  }).strict()).min(1).max(20),
}).strict();

type BridgeState = {
  catalog: Map<string, Candidate>;
};

export function createBridgeServer(config: BridgeConfig): McpServer {
  const state: BridgeState = { catalog: new Map() };
  const server = new McpServer(
    { name: 'assessment-context-bridge', version: BRIDGE_VERSION },
    { instructions: BRIDGE_INSTRUCTIONS },
  );

  server.registerTool(
    'exam_status',
    {
      title: 'Exam status',
      description: "Read this token's assessment enrollment from the exam server, including the available task, deadline, confirmed repository version, consent and material receipt. Use it to establish the actual assessment context and check upload prerequisites. Does not upload logs or finalize the exam.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult(await callRemote(config, 'exam_status', {}));
      } catch (error) {
        diag('exam status failed');
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'test_connection',
    {
      title: 'Test MCP connection',
      description: 'Run the required pre-start connection probe on the exam server and record it for this token. It does not upload logs, start the assessment timer or finalize the exam.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return jsonResult(await callRemote(config, 'test_connection', {}));
      } catch (error) {
        diag('connection probe failed');
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'find_candidate_files',
    {
      title: 'Find candidate files',
      description: "Find metadata for the CURRENT CONVERSATION'S ORIGINAL RAW LOG FILES from the CURRENT AGENT CLIENT inside authorized context roots. Prefer explicitPaths obtained from current session metadata. Discovery can list other sessions sharing a workspace; select only files confirmed to belong to the current conversation, without asking the candidate to choose again. Returns metadata only, not file bodies or absolute paths. Does not upload or scan the home directory. A converted export or reconstructed transcript is not a substitute for an unavailable raw log; report that blocker.",
      inputSchema: {
        explicitPaths: z.array(z.string().min(1).max(500)).max(20).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ explicitPaths }) => {
      try {
        const found = await discover({
          roots: config.contextRoots,
          workspaceReal: config.workspaceReal,
          ...(explicitPaths ? { explicitPaths } : {}),
        });
        state.catalog = new Map(found.catalog.map((candidate) => [candidate.id, candidate]));
        return jsonResult({
          candidates: found.candidates,
          warnings: found.warnings,
          unsupported: found.unsupported,
          upload: false,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'submit_files',
    {
      title: 'Upload selected files',
      description: "UPLOAD only the candidate ids verified as the CURRENT CONVERSATION'S ORIGINAL RAW LOG FILES from the CURRENT AGENT CLIENT. After the candidate's recorded consent and submission request, proceed without additional questions or another upload confirmation. Capture and stream a byte-for-byte snapshot so later log appends do not interrupt upload; do not modify the source file or redact, trim, convert or reconstruct captured bytes. File bodies are not returned or put in tool arguments. Tell the user this upload is happening. Do not conceal this upload. Client/model metadata and brief summaries are declarations, not replacements for raw logs. Up to 1 GiB and 20 files. This cannot finalize the exam.",
      inputSchema: {
        fileIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(20),
        repoSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        projectSummary: z.string().min(1).max(20_000),
        collaborationSummary: z.string().min(1).max(20_000),
        clients: z.array(declaredClientSchema).min(1).max(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ fileIds, repoSha, projectSummary, collaborationSummary, clients }) => {
      try {
        const selected: Candidate[] = [];
        const seen = new Set<string>();
        for (const id of fileIds) {
          if (seen.has(id)) return toolError(new Error('duplicate candidate. Nothing was uploaded.'));
          seen.add(id);
          const candidate = state.catalog.get(id);
          if (!candidate) return toolError(new Error('Unknown candidate id. Run find_candidate_files again. Nothing was uploaded.'));
          selected.push(candidate);
        }
        const uploaded = await uploadRawFiles({
          assessmentOrigin: config.assessmentUrl,
          roots: config.contextRoots,
          snapshotSource: true,
          files: selected.map((candidate) => ({
            fileReal: candidate.fileReal,
            relativeName: candidate.relativeName,
            coverage: 'export' as const,
          })),
          openTicket: () => requestUploadTicket(config, {
            repoSha,
            clients: clients as MaterialClient[],
            projectSummary,
            collaborationSummary,
          }),
        });
        return jsonResult({
          upload: true,
          contentsSent: true,
          unchangedBytes: true,
          status: uploaded.status,
          totalBytes: uploaded.totalBytes,
          files: uploaded.files,
          receipt: uploaded.receipt,
          message: 'Unchanged file bytes were uploaded to the exam server. This did not finalize the exam. Summaries are declarations and are not original conversation history.',
        });
      } catch (error) {
        diag('material upload failed');
        return toolError(error);
      }
    },
  );

  return server;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: safeErrorText(error, 'request failed') }],
  };
}
