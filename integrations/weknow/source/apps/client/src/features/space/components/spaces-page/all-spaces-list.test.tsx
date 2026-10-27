import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, useLocation } from "react-router-dom";
import AllSpacesList from "./all-spaces-list";
import { ISpace } from "@/features/space/types/space.types";
const mocks = vi.hoisted(() => ({
  star: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (s: string, v?: Record<string, unknown>) =>
      s.replace(/\{\{(\w+)\}\}/g, (_, k) => String(v?.[k] ?? "")),
  }),
}));
vi.mock("@/features/space/queries/space-query", () => ({
  prefetchSpace: mocks.prefetch,
}));
vi.mock("@/features/space/queries/space-watcher-query", () => ({
  useWatchedSpaceIds: () => new Set(),
  useWatchSpaceMutation: () => ({ mutate: mocks.watch }),
  useUnwatchSpaceMutation: () => ({ mutate: mocks.unwatch }),
}));
vi.mock("@/features/favorite/queries/favorite-query", () => ({
  useFavoriteIds: () => new Set(),
  useAddFavoriteMutation: () => ({ mutate: mocks.star }),
  useRemoveFavoriteMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/space/components/settings-modal", () => ({
  default: ({ opened, spaceId }: { opened: boolean; spaceId: string }) =>
    opened ? <div role="dialog">{spaceId}</div> : null,
}));
vi.mock("@/lib", () => ({
  formatMemberCount: (count: number) => `${count} members`,
}));
vi.mock("@/components/ui/custom-avatar.tsx", () => ({
  CustomAvatar: ({ name }: { name: string }) => <span>{name}</span>,
}));
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const space = {
  id: "00000000-0000-4000-8000-000000000100",
  slug: "engineering",
  name: "Actual space",
  description: "Actual description from the server",
  memberCount: 7,
} as ISpace;
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function mount(spaces: ISpace[] = [space], onSearch = vi.fn()) {
  render(
    <MantineProvider>
      <MemoryRouter initialEntries={["/spaces"]}>
        <AllSpacesList
          spaces={spaces}
          onSearch={onSearch}
          hasPrevPage={false}
          hasNextPage={false}
          onNext={vi.fn()}
          onPrev={vi.fn()}
        />
        <Location />
      </MemoryRouter>
    </MantineProvider>,
  );
  return onSearch;
}
describe("space cards preserve existing actions and live fields", () => {
  it("uses supplied metadata and routes through the existing slug", () => {
    mount();
    expect(screen.getByText(space.description)).toBeTruthy();
    expect(screen.getByText("7 members")).toBeTruthy();
    const link = screen.getByRole("link", { name: space.name });
    expect(link.querySelector("button")).toBeNull();
    fireEvent.click(link);
    expect(screen.getByTestId("location").textContent).toBe("/s/engineering");
  });
  it("favorite and watch stay separate from card navigation; settings use the same space UUID", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Add Actual space to favorites" }),
    );
    expect(mocks.star).toHaveBeenCalledWith(
      expect.objectContaining({ type: "space", spaceId: space.id }),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Watch space" }));
    expect(mocks.watch).toHaveBeenCalledWith(space.id);
    expect(screen.getByTestId("location").textContent).toBe("/spaces");
    fireEvent.click(screen.getByRole("button", { name: "Space menu" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Space settings" }),
    );
    expect(screen.getByRole("dialog").textContent).toBe(space.id);
    expect(screen.getByTestId("location").textContent).toBe("/spaces");
  });
  it("keeps search and handles missing descriptions without inserting mock copy", async () => {
    const onSearch = mount([{ ...space, description: "" }]);
    expect(screen.queryByText(space.description)).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), {
      target: { value: "query" },
    });
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("query"));
  });
  it("keeps the empty search result with no fabricated spaces", () => {
    mount([]);
    expect(screen.getByText("No results found...")).toBeTruthy();
    expect(
      screen.queryByRole("list", { name: "List of spaces in this workspace" }),
    ).toBeNull();
  });
});
