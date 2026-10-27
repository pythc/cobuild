import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SpaceSettingsModal from "./settings-modal";

const mocks = vi.hoisted(() => ({
  useSpaceQuery: vi.fn(),
  summary: vi.fn(({ spaceId }: { spaceId: string }) => <div data-testid="access-summary">{spaceId}</div>),
}));
vi.mock("@/features/space/queries/space-query", () => ({ useSpaceQuery: mocks.useSpaceQuery }));
vi.mock("./space-access-summary", () => ({ default: mocks.summary }));
vi.mock("./space-members", () => ({ default: () => <div>Members</div> }));
vi.mock("./add-space-members-modal", () => ({ default: () => null }));
vi.mock("./space-details", () => ({ default: () => null }));
vi.mock("@/features/public-space/components/publish-space-settings", () => ({ default: () => null }));
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
describe("space settings with a slug entry point", () => {
  it("passes only the resolved UUID to access details and hides the empty security tab", () => {
    const id = "00000000-0000-4000-8000-000000000100";
    mocks.useSpaceQuery.mockReturnValue({ data: { id, name: "Engineering", membership: { permissions: [{ action: "manage", subject: "settings" }, { action: "manage", subject: "member" }] } } });
    render(<MantineProvider><SpaceSettingsModal spaceId="engineering" opened onClose={() => {}} /></MantineProvider>);
    expect(screen.getByTestId("access-summary").textContent).toBe(id);
    expect(screen.queryByRole("tab", { name: "Security" })).toBeNull();
  });
});
