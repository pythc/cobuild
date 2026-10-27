import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useState } from "react";
import { MultiMemberSelect } from "./multi-member-select";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/features/search/queries/search-query.ts", () => ({ useSearchSuggestionsQuery: mocks.query }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/custom-avatar.tsx", () => ({ CustomAvatar: () => null }));
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => mocks.query.mockReturnValue({ data: { groups: [{ id: "default", name: "Everyone", isDefault: true }, { id: "manual", name: "全体成员", isDefault: false }], users: [] }, isFetching: false, isError: false }));
afterEach(cleanup);
function Harness() {
  const [value, setValue] = useState<string[]>([]);
  return <MantineProvider><MultiMemberSelect value={value} onChange={setValue} /></MantineProvider>;
}
describe("space member picker", () => {
  it("loads without typing and distinguishes the automatic default group", () => {
    render(<Harness />);
    expect(mocks.query).toHaveBeenLastCalledWith(expect.objectContaining({ query: "", preload: true, includeGroups: true, includeUsers: true }));
    fireEvent.click(screen.getByRole("combobox", { name: "Add members" }));
    expect(screen.getByRole("option", { name: "All members (automatic)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "全体成员" })).toBeTruthy();
  });
  it("keeps the selected group label after a different query replaces results", () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("combobox", { name: "Add members" }));
    fireEvent.click(screen.getByRole("option", { name: "All members (automatic)" }));
    mocks.query.mockReturnValue({ data: { groups: [], users: [{ id: "alice", name: "Alice" }] } });
    view.rerender(<Harness />);
    expect(screen.getByText("All members (automatic)")).toBeTruthy();
    expect(screen.queryByText("group-default")).toBeNull();
  });
  it("shows a retryable load error instead of a silent empty dropdown", () => {
    mocks.query.mockReturnValue({ isFetching: false, isError: true });
    render(<Harness />);
    expect(screen.getByText("Could not load members. Try again.")).toBeTruthy();
  });
  it("shows an empty result message", () => {
    mocks.query.mockReturnValue({ data: { groups: [], users: [] }, isFetching: false });
    render(<Harness />);
    fireEvent.click(screen.getByRole("combobox", { name: "Add members" }));
    expect(screen.getByText("No results found")).toBeTruthy();
  });
  it("marks externally managed groups as synchronized", () => {
    mocks.query.mockReturnValue({ data: { groups: [{ id: "dept", name: "飞书 · 开发组", isExternal: true }], users: [] } });
    render(<Harness />);
    fireEvent.click(screen.getByRole("combobox", { name: "Add members" }));
    expect(screen.getByRole("option", { name: "飞书 · 开发组 Feishu sync" })).toBeTruthy();
  });

});
