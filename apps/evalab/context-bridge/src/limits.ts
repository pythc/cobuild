export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 1024 * 1024;
/** Direct upload aggregate cap. Matches server MAX_MATERIAL_BYTES (1 GiB). */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** Direct upload chunk cap. Matches server CHUNK_BYTES (4 MiB). */
export const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_SUMMARY_CHARS = 20_000;
export const MAX_WALK_ENTRIES = 2_000;
export const MAX_WALK_DEPTH = 6;
export const MAX_CANDIDATES = 100;
export const MAX_LINE_BYTES = 1_500_000;
export const HEAD_BYTES = 65_536;
export const PREVIEW_CHARS = 400;
export const MAX_CURSOR_RAW_BYTES = 8 * 1024 * 1024;
export const MAX_CLIENTS = 30;
export const MAX_MODELS = 20;
export const MAX_PARAMETERS = 20;
export const MAX_LABEL_CHARS = 120;
