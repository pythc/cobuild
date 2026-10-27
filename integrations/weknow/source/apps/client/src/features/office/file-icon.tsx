import {
  IconCloud,
  IconFile,
  IconFileTypeDocx,
  IconFileTypeXls,
  IconFileTypePpt,
  IconFileTypePdf,
  IconFolder,
  IconFileDescription,
  IconMarkdown,
  IconPhoto,
  IconFileZip,
  IconTable,
  IconMovie,
  IconMusic,
  IconCode,
  IconFileText,
} from "@tabler/icons-react";
export function FileIcon({
  type = "page",
  ext,
  size = 22,
  color: overrideColor,
}: {
  type?: string;
  ext?: string;
  size?: number;
  color?: string;
}) {
  ext = ext?.toLowerCase().replace(/^\./, "");
  const [Icon, typeColor] =
    type === "base"
      ? [IconTable, "#4e7bbd"]
      : type === "folder"
        ? [IconFolder, "#c49b46"]
        : type === "page"
          ? [IconFileDescription, "#4e7bbd"]
          : ["md", "markdown", "mdown"].includes(ext || "")
            ? [IconMarkdown, "#4e7bbd"]
            : ["doc", "docx", "odt"].includes(ext || "")
              ? [IconFileTypeDocx, "#4e7bbd"]
              : ["xls", "xlsx", "csv", "ods"].includes(ext || "")
                ? [IconFileTypeXls, "#36917d"]
                : ["ppt", "pptx", "odp"].includes(ext || "")
                  ? [IconFileTypePpt, "#cf8059"]
                  : ext === "pdf"
                    ? [IconFileTypePdf, "#c86c76"]
                    : ["png", "jpg", "jpeg", "webp", "gif"].includes(ext || "")
                      ? [IconPhoto, "#9277b5"]
                      : ["mp4", "webm", "mov", "avi"].includes(ext || "")
                        ? [IconMovie, "#9277b5"]
                        : ["mp3", "wav", "ogg", "m4a", "flac"].includes(
                              ext || "",
                            )
                          ? [IconMusic, "#9277b5"]
                          : [
                                "js",
                                "ts",
                                "tsx",
                                "jsx",
                                "py",
                                "json",
                                "yaml",
                                "yml",
                                "sh",
                                "html",
                                "css",
                                "sql",
                              ].includes(ext || "")
                            ? [IconCode, "#8290a6"]
                            : ["txt", "rtf", "log"].includes(ext || "")
                              ? [IconFileText, "#8290a6"]
                              : ["zip", "rar", "7z", "gz", "tar"].includes(
                                    ext || "",
                                  )
                                ? [IconFileZip, "#8290a6"]
                                : [IconFile, "#8290a6"];
  const color = overrideColor || typeColor;
  return (
    <span
      style={{
        display: "inline-flex",
        position: "relative",
        flexShrink: 0,
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon size={size} stroke={1.6} color={color as string} />
      {type === "office" && (
        <IconCloud
          size={10}
          stroke={2}
          style={{
            position: "absolute",
            right: -2,
            bottom: -1,
            color: color as string,
            background: "var(--mantine-color-body)",
            borderRadius: 4,
          }}
        />
      )}
    </span>
  );
}
