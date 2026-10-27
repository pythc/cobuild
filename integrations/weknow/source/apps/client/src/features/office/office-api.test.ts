import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/api-client", () => ({ default: { post: vi.fn() } }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));
import api from "@/lib/api-client";
import { officePost, listDirectory, uploadFile } from "./office-api";
describe("Office API integration with the existing response interceptor", () => {
  beforeEach(() => vi.clearAllMocks());
  it("unwraps the server data envelope returned by the shared interceptor", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: "file" } });
    expect(await officePost("/office/info", {})).toEqual({ id: "file" });
  });
  it("collects every cursor page and orders fractional positions case sensitively", async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "b", position: "a0" }],
          nextCursor: "cursor",
          officeEnabled: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "a", position: "Zz" }],
          nextCursor: null,
          officeEnabled: true,
        },
      });
    const directory = await listDirectory({
      spaceId: "space",
      parentPageId: "folder",
    });
    expect(directory.items.map((p) => p.id)).toEqual(["a", "b"]);
    expect(api.post).toHaveBeenLastCalledWith(
      "/office/list",
      { spaceId: "space", parentPageId: "folder", cursor: "cursor" },
      undefined,
    );
  });
  it("keeps the selected upload destination and reserves 100 percent for the server receipt", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { id: "new-file" } });
    const progress = vi.fn();
    await uploadFile(
      new File(["test"], "note.txt"),
      { spaceId: "space", parentPageId: "folder" },
      progress,
    );
    const [, form, options] = vi.mocked(api.post).mock.calls[0];
    expect((form as FormData).get("parentPageId")).toBe("folder");
    options!.onUploadProgress!({ loaded: 4, total: 4 } as any);
    expect(progress).toHaveBeenCalledWith(99);
  });
});
