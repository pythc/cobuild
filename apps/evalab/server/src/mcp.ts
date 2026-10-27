import type { IncomingMessage } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateMcp, getMcpStatus, probeMcp } from "./assessment.js";
import { containsSecretMarker } from "./security.js";
import { createMaterialUpload, directMetadataSchema } from "./uploads.js";
import type { McpIdentity } from "./assessment.js";
import type { AppContext } from "./context.js";

const JSON_LIMIT = "256kb";
const INSTRUCTIONS = [
  "You are assisting a candidate in the 110 Laboratory recruitment assessment for Chongqing University of Posts and Telecommunications students. The candidate uses a self-chosen coding Agent to build a real project in the product or development/testing track. The assessment reviews the submitted repository version together with the candidate's Agent-assisted project work. The attempt duration is configured per batch and captured when the candidate starts it. Use exam_status for the candidate's personal deadline; the batch's latest-start time does not end an already started attempt.",
  "Call exam_status to obtain this authenticated enrollment's actual state, track, available task, deadline, confirmed repository SHA, direct-upload consent and material receipt. Do not invent task details. Connecting, initialization and test_connection do not request a file upload or start the timer.",
  "When the candidate asks to submit materials, the required material is the CURRENT CONVERSATION'S ORIGINAL RAW LOG FILE from the CURRENT AGENT CLIENT for this assessment project. Identify it from the client's current session id, log path or session-index metadata. Include additional raw log segments only when they belong to that same conversation. Matching a workspace alone does not establish that a file belongs to the current conversation. Do not substitute other sessions, other clients, reconstructed transcripts, summaries or converted exports.",
  "After exam_status confirms the required consent, an active attempt and the confirmed repository SHA, proceed directly within the client's existing file permissions. Do not ask additional questions, request another upload approval, or ask the candidate to select files or repeat client/model/project details that are already available. Briefly state that the current-session raw log is being uploaded; this is a notice, not a confirmation gate. Do not conceal the upload. Missing consent, permissions, repository confirmation or an unidentifiable/unavailable raw log is a blocker: report it accurately, without bypassing it, uploading another conversation, or claiming completion.",
  "Use known client/model metadata; use unknown for unavailable values and do not guess. Write brief project and collaboration summaries from the context already available. Call submit_materials with the confirmed repoSha, clients, projectSummary and collaborationSummary only. Do not put file bodies or file hashes in MCP arguments.",
  "submit_materials returns a short-lived upload ticket and the official upload-materials.py helper URL. Download the helper and run python3 upload-materials.py --url UPLOAD_URL --token UPLOAD_TOKEN --snapshot --file RAW_LOG_PATH, repeating --file only for raw segments of the same current conversation; alternatively use --ticket-file TICKET.json. Do not use --payload-json for current-session raw logs. The helper makes a byte-for-byte snapshot of each file at the start of capture, leaves the original file untouched, and uploads that snapshot. Later appended log entries are outside that snapshot; it does not filter or truncate the captured bytes. This avoids failures caused by an active log continuing to grow.",
  "Do not read raw log bodies into the model context, rewrite, redact, trim, reformat, re-encode, or reconstruct them. File copying, hashing and transfer are performed by code as bytes. Do not separately collect unrelated conversations, other projects, credential stores or hidden instruction files. The total limit is 1 GiB across at most 20 files, transferred in 4 MiB chunks with resume support. Verify the returned receipt before reporting success.",
  "After upload, call exam_status to confirm that the material receipt matches the repository SHA. Receiving materials does not finalize the exam. The candidate must still click 确认交卷 on the website; this MCP cannot finalize the exam.",
].join(" ");

const jsonParser = express.json({
  limit: JSON_LIMIT,
  type: ["application/json", "application/*+json"],
});

export function registerMcp(app: Express, ctx: AppContext): void {
  app.options("/mcp", (req, res) => {
    if (!transportAllowed(req, ctx) || !validRequestOrigin(req)) {
      res.sendStatus(403);
      return;
    }
    setMcpCors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
    );
    res.sendStatus(204);
  });
  app.post("/mcp", (req, res) => {
    void handlePost(req, res, ctx).catch(() => {
      if (!res.headersSent)
        sendJsonRpc(res, 500, -32603, "Internal server error");
    });
  });
  app.get("/mcp", (req, res) => {
    void handleStatelessVerb(req, res, ctx).catch(() => {
      if (!res.headersSent)
        sendJsonRpc(res, 500, -32603, "Internal server error");
    });
  });
  app.delete("/mcp", (req, res) => {
    void handleStatelessVerb(req, res, ctx).catch(() => {
      if (!res.headersSent)
        sendJsonRpc(res, 500, -32603, "Internal server error");
    });
  });
  app.all("/mcp", (_req, res) => {
    sendJsonRpc(res, 405, -32000, "Method not allowed");
  });
}

async function handlePost(
  req: Request,
  res: Response,
  ctx: AppContext,
): Promise<void> {
  const identity = await authorize(req, res, ctx);
  if (!identity) return;
  const parsed = await readJsonBody(req, res);
  if (!parsed) return;
  const server = buildServer(ctx, identity);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  transport.onerror = () => {
    diag("transport error");
  };
  server.server.onerror = () => {
    diag("mcp server error");
  };
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    const mcpReq = req as IncomingMessage & { auth?: undefined };
    delete (mcpReq as { auth?: unknown }).auth;
    await transport.handleRequest(mcpReq, res, req.body);
  } catch {
    diag("request failed");
    if (!res.headersSent)
      sendJsonRpc(res, 500, -32603, "Internal server error");
  }
}

async function handleStatelessVerb(
  req: Request,
  res: Response,
  ctx: AppContext,
): Promise<void> {
  const identity = await authorize(req, res, ctx);
  if (!identity) return;
  res.setHeader("Allow", "POST");
  sendJsonRpc(res, 405, -32000, "Method not allowed");
}

async function authorize(
  req: Request,
  res: Response,
  ctx: AppContext,
): Promise<McpIdentity | null> {
  if (!transportAllowed(req, ctx) || !validRequestOrigin(req)) {
    sendJsonRpc(res, 403, -32000, "Forbidden");
    return null;
  }
  if (hasCredentialQuery(req)) {
    sendJsonRpc(
      res,
      400,
      -32000,
      "Credentials must be sent in the Authorization header",
    );
    return null;
  }
  const token = extractBearer(req.headers.authorization);
  const challenge = `Bearer resource_metadata="${ctx.config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp", scope="assessment"`;
  setMcpCors(req, res);
  delete req.headers.authorization;
  delete req.headers["proxy-authorization"];
  if (!token) {
    res.setHeader("WWW-Authenticate", challenge);
    sendJsonRpc(res, 401, -32000, "Unauthorized");
    return null;
  }
  try {
    const identity = await authenticateMcp(ctx, token);
    if (!isIdentity(identity)) {
      sendJsonRpc(res, 401, -32000, "Unauthorized");
      return null;
    }
    const origin = req.get("origin");
    if (
      origin &&
      origin !== ctx.config.appOrigin &&
      !identity.oauthOrigins?.includes(origin)
    ) {
      sendJsonRpc(res, 403, -32000, "Forbidden");
      return null;
    }
    return identity;
  } catch {
    diag("auth failed");
    res.setHeader("WWW-Authenticate", challenge);
    sendJsonRpc(res, 401, -32000, "Unauthorized");
    return null;
  }
}

function buildServer(ctx: AppContext, identity: McpIdentity): McpServer {
  const server = new McpServer(
    { name: "110-lab-assessment", version: "0.2.2" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "exam_status",
    {
      title: "Exam status",
      description:
        "Read the authenticated candidate's own assessment enrollment: state, track, available task, deadline, consent, MCP connection, confirmed repository SHA and material receipt. Call this to establish the actual assessment context and check upload prerequisites. Does not upload files or finalize the exam. The token cannot access another enrollment.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return jsonResult(redactKeys(await getMcpStatus(ctx, identity)));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test MCP connection",
      description:
        "Probe this enrollment token and record the candidate's pre-start MCP connection check. It does not upload conversation logs, start the assessment timer or finalize the exam. The candidate starts the assessment on the website.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const probe = await probeMcp(ctx, identity);
        if (!probe || probe.ok !== true)
          return toolFailure(new Error("connection probe did not succeed"));
        return jsonResult(redactKeys(probe));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "submit_materials",
    {
      title: "Upload exam project files",
      description:
        "Create a scoped upload ticket for the confirmed repository SHA to submit the CURRENT CONVERSATION'S ORIGINAL RAW LOG FILE from the CURRENT AGENT CLIENT. Provide only client/model metadata and brief project/collaboration summaries, never file contents. After the candidate's recorded direct-upload consent and submission request, proceed without additional questions or another upload confirmation. Run the returned official helper with --snapshot --file RAW_LOG_PATH to upload a byte-for-byte captured version, without changing the original, reading bodies into model context, redacting, trimming or converting content. Up to 1 GiB total and 20 files, all from that same conversation. Report a genuine missing prerequisite or unavailable raw log instead of substituting another session. Briefly announce the upload and report success only after a verified receipt. This does not finalize the exam.",
      inputSchema: directMetadataSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        return jsonResult(await createMaterialUpload(ctx, identity, args));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  return server;
}

function transportAllowed(req: Request, ctx: AppContext): boolean {
  const expected = trustedOrigin(ctx.config?.appOrigin);
  if (!expected) return false;
  const host = firstHeader(req.headers.host)?.toLowerCase();
  if (!host || !expected.hosts.includes(host)) return false;
  return true;
}

function trustedOrigin(
  appOrigin: string | undefined,
): { origin: string; hosts: string[] } | null {
  if (!appOrigin) return null;
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const hosts = new Set<string>([url.host.toLowerCase()]);
  if (!url.port) {
    if (url.protocol === "https:")
      hosts.add(`${url.hostname.toLowerCase()}:443`);
    if (url.protocol === "http:") hosts.add(`${url.hostname.toLowerCase()}:80`);
  }
  return { origin: url.origin, hosts: [...hosts] };
}

function validRequestOrigin(req: Request): boolean {
  const raw = req.get("origin");
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return raw === url.origin && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function setMcpCors(req: Request, res: Response): void {
  const origin = req.get("origin");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.vary("Origin");
  }
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version",
  );
}

function hasCredentialQuery(req: Request): boolean {
  try {
    const url = new URL(req.originalUrl || req.url, "http://localhost");
    for (const key of url.searchParams.keys()) {
      if (/token|authorization|password|secret/i.test(key)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function extractBearer(value: string | string[] | undefined): string | null {
  const header = firstHeader(value);
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token || token.length < 20 || token.length > 200) return null;
  return token;
}

function isIdentity(value: unknown): value is McpIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as { userId?: unknown; enrollmentId?: unknown };
  return (
    typeof identity.userId === "string" &&
    typeof identity.enrollmentId === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(identity.userId) &&
    /^[A-Za-z0-9-]{1,64}$/.test(identity.enrollmentId)
  );
}

function readJsonBody(req: Request, res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    jsonParser(req, res, (error: unknown) => {
      if (!error) {
        resolve(true);
        return;
      }
      const status = (error as { status?: number }).status;
      if (status === 413) sendJsonRpc(res, 413, -32000, "Payload too large");
      else sendJsonRpc(res, 400, -32700, "Invalid JSON");
      resolve(false);
    });
  });
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolFailure(error: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: publicError(error) }],
  };
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  if (!message || message.length > 300 || containsSecretMarker(message))
    return "Request failed";
  return message;
}

function redactKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactKeys(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (/token|authorization|password|secret|cookie/i.test(key)) continue;
      out[key] = redactKeys(item);
    }
    return out;
  }
  return value;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJsonRpc(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res
    .status(status)
    .set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function diag(event: string): void {
  console.error(`mcp ${event}`);
}
