import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
vi.mock("@/lib/api-client", () => ({ default: { get: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
import {
  rankWriting,
  WeeklyWritingCard,
  type WritingMember,
} from "./weekly-writing";
const members: WritingMember[] = [
  { userId: "a", name: "甲", characters: 50, edits: 2, createdPages: 1 },
  { userId: "b", name: "乙", characters: 50, edits: 7, createdPages: 3 },
  { userId: "c", name: "丙", characters: 0, edits: 0, createdPages: 0 },
];
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi
      .fn()
      .mockImplementation((query) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(cleanup);
describe("weekly writing panel", () => {
  it("uses shared ranks on ties without mutating the API result", () => {
    const result = rankWriting(members, "characters");
    expect(
      result.filter((m) => m.characters === 50).map((m) => m.rank),
    ).toEqual([1, 1]);
    expect(members.map((m) => m.userId)).toEqual(["a", "b", "c"]);
  });
  it("switches the dimension and displays actual zero-activity members", () => {
    render(
      <MantineProvider>
        <WeeklyWritingCard
          data={{
            start: "2026-10-11T16:00:00Z",
            end: "2026-10-18T16:00:00Z",
            trackingSince: "2026-10-16T16:00:00Z",
            members,
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByText("丙")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Edits"));
    const rows = screen.getAllByRole("listitem");
    expect(rows[0].textContent).toContain("乙");
    expect(rows[0].textContent).toContain("7");
  });
  it("explains whole-week page counts separately from partial-week character tracking", () => {
    render(
      <MantineProvider>
        <WeeklyWritingCard data={{
          start: "2026-10-11T16:00:00Z",
          end: "2026-10-18T16:00:00Z",
          trackingSince: "2026-10-16T19:54:51Z",
          members,
        }} />
      </MantineProvider>,
    );
    expect(screen.getByText(/Character and edit tracking since/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("New pages"));
    expect(screen.getByText("All pages created this week, including subpages")).toBeTruthy();
    expect(screen.queryByText(/Character and edit tracking since/)).toBeNull();
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("乙");
    fireEvent.click(screen.getByLabelText("Net characters"));
    expect(screen.getByText(/Character and edit tracking since/)).toBeTruthy();
  });
  it("offers retry on a real service error instead of presenting invented zero totals", () => {
    const retry = vi.fn();
    render(
      <MantineProvider>
        <WeeklyWritingCard error onRetry={retry} />
      </MantineProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});
