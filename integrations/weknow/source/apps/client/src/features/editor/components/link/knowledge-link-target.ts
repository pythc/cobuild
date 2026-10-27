export type KnowledgeLinkTarget = {
  kind: "page" | "attachment";
  id: string;
  href: string;
};

// Only known routes on this workspace's origin are eligible for resolution.
// A host name in a query string, user-info or an external URL is never enough.
export function parseKnowledgeLink(
  value: string,
  origin: string,
): KnowledgeLinkTarget | null {
  try {
    const url = new URL(value.trim(), origin);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.origin !== new URL(origin).origin ||
      url.username ||
      url.password
    )
      return null;
    const page = /^\/(?:s\/[^/]+\/|docs\/[^/]+\/)?p\/([\w-]+)\/?$/.exec(
      url.pathname,
    );
    if (page) {
      const slug = page[1];
      const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(slug)
        ? slug
        : slug.split("-").pop();
      if (id) return { kind: "page", id, href: url.href };
    }
    const download = /^\/api\/office\/download\/([0-9a-f-]{36})\/?$/i.exec(
      url.pathname,
    );
    if (download) return { kind: "page", id: download[1], href: url.href };
    const file = /^\/api\/files\/([0-9a-f-]{36})\/[^/]+$/i.exec(url.pathname);
    if (file) return { kind: "attachment", id: file[1], href: url.href };
  } catch {
    /* Keep invalid and external URLs as ordinary links. */
  }
  return null;
}
