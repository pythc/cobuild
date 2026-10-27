import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function createStateStore(rootDir, options = {}) {
  const directory = path.join(rootDir, "state");
  const file = path.join(directory, "runtime.json");
  const maxConversationTurns = options.maxConversationTurns || 12;
  const maxConversationChats = options.maxConversationChats || 200;
  const conversationTtlMs = (options.conversationTtlDays || 7) * 24 * 60 * 60 * 1000;
  let state = {
    processedMessages: [],
    scheduledPosts: {},
    conversations: {},
    requirementSnapshots: {},
    collaborationBaselineReady: false,
    collaborationSnapshotVersion: 0,
    collaborationLastScanAt: null
  };
  let saveQueue = Promise.resolve();

  function pruneConversations(now = Date.now()) {
    const cutoff = now - conversationTtlMs;
    for (const [chatId, turns] of Object.entries(state.conversations)) {
      const recent = Array.isArray(turns)
        ? turns.filter((turn) => Date.parse(turn.at || 0) >= cutoff).slice(-maxConversationTurns)
        : [];
      if (recent.length) state.conversations[chatId] = recent;
      else delete state.conversations[chatId];
    }
    const chats = Object.entries(state.conversations)
      .sort(([, left], [, right]) => {
        const leftAt = Date.parse(left.at(-1)?.at || 0);
        const rightAt = Date.parse(right.at(-1)?.at || 0);
        return rightAt - leftAt;
      })
      .slice(0, maxConversationChats);
    state.conversations = Object.fromEntries(chats);
  }

  async function load() {
    await mkdir(directory, { recursive: true });
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    state.processedMessages ||= [];
    state.scheduledPosts ||= {};
    state.conversations ||= {};
    state.requirementSnapshots ||= {};
    state.collaborationBaselineReady ||= false;
    state.collaborationSnapshotVersion = Number.isInteger(state.collaborationSnapshotVersion)
      ? state.collaborationSnapshotVersion
      : 0;
    state.collaborationLastScanAt = typeof state.collaborationLastScanAt === "string"
      ? state.collaborationLastScanAt
      : null;
    pruneConversations();
  }

  function save() {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const pending = saveQueue.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, serialized, "utf8");
      await rename(temp, file);
    });
    saveQueue = pending;
    return pending;
  }

  function hasProcessed(messageId) {
    return state.processedMessages.includes(messageId);
  }

  async function markProcessed(messageId) {
    state.processedMessages.push(messageId);
    state.processedMessages = state.processedMessages.slice(-2000);
    await save();
  }

  function scheduledKeySent(key) {
    return Boolean(state.scheduledPosts[key]);
  }

  async function markScheduled(key) {
    state.scheduledPosts[key] = new Date().toISOString();
    const entries = Object.entries(state.scheduledPosts).slice(-1000);
    state.scheduledPosts = Object.fromEntries(entries);
    await save();
  }

  function getConversation(chatId) {
    pruneConversations();
    return (state.conversations[chatId] || []).map((turn) => ({ ...turn }));
  }

  async function appendConversation(chatId, turn) {
    if (!chatId) return;
    const record = {
      user: String(turn.user || "").slice(0, 2000),
      assistant: String(turn.assistant || "").slice(0, 4000),
      intent: turn.intent?.type || "unknown",
      iterationName: turn.intent?.iterationName || "",
      at: turn.at || new Date().toISOString()
    };
    state.conversations[chatId] ||= [];
    state.conversations[chatId].push(record);
    pruneConversations();
    await save();
  }

  function getRequirementSnapshot(recordId) {
    const snapshot = state.requirementSnapshots[recordId];
    return snapshot ? structuredClone(snapshot) : null;
  }

  function listRequirementSnapshots() {
    return structuredClone(state.requirementSnapshots);
  }

  async function setRequirementSnapshot(recordId, snapshot) {
    state.requirementSnapshots[recordId] = structuredClone(snapshot);
    await save();
  }

  async function replaceRequirementSnapshots(snapshots) {
    state.requirementSnapshots = structuredClone(snapshots || {});
    await save();
  }

  function isCollaborationBaselineReady() {
    return state.collaborationBaselineReady === true;
  }

  async function markCollaborationBaselineReady() {
    state.collaborationBaselineReady = true;
    await save();
  }

  function getCollaborationSnapshotVersion() {
    return state.collaborationSnapshotVersion;
  }

  async function setCollaborationSnapshotVersion(version) {
    state.collaborationSnapshotVersion = Number(version) || 0;
    await save();
  }

  function getCollaborationLastScanAt() {
    return state.collaborationLastScanAt;
  }

  async function setCollaborationLastScanAt(value) {
    state.collaborationLastScanAt = value || null;
    await save();
  }

  return {
    load,
    hasProcessed,
    markProcessed,
    scheduledKeySent,
    markScheduled,
    getConversation,
    appendConversation,
    getRequirementSnapshot,
    listRequirementSnapshots,
    setRequirementSnapshot,
    replaceRequirementSnapshots,
    isCollaborationBaselineReady,
    markCollaborationBaselineReady,
    getCollaborationSnapshotVersion,
    setCollaborationSnapshotVersion,
    getCollaborationLastScanAt,
    setCollaborationLastScanAt
  };
}
