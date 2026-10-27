import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  results: [] as any[],
  pending: false,
  debounce: undefined as string | undefined,
  search: vi.fn(),
}));
vi.mock("../constants.ts", () => ({ searchSpotlightStore: {} }));
vi.mock("@mantine/spotlight", () => ({
  Spotlight: {
    Root: ({ children, query, onQueryChange }: any) => (
      <section>
        <input
          aria-label="test query"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {children}
      </section>
    ),
    Search: () => null,
    ActionsList: ({ children }: any) => <div>{children}</div>,
    Empty: ({ children }: any) => <div>{children}</div>,
  },
}));
vi.mock("@mantine/core", () => ({
  Group: ({ children }: any) => <div>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
  VisuallyHidden: ({ children, role }: any) => (
    <span role={role}>{children}</span>
  ),
}));
vi.mock("@mantine/hooks", () => ({
  useDebouncedValue: (value: string) => [state.debounce ?? value],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../hooks/use-unified-search.ts", () => ({
  useUnifiedSearch: (...args: any[]) => {
    state.search(...args);
    return { data: state.results, isFetching: state.pending };
  },
}));
vi.mock("./search-spotlight-filters.tsx", () => ({
  SearchSpotlightFilters: ({ onFiltersChange }: any) => (
    <button
      onClick={() =>
        onFiltersChange({ spaceId: "second-space", contentType: "all" })
      }
    >
      Change space
    </button>
  ),
}));
vi.mock("./search-result-item.tsx", () => ({
  SearchResultItem: ({ result }: any) => <article>{result.title}</article>,
}));

import { SearchSpotlight } from "./search-spotlight";

describe("community search without enterprise AI modules", () => {
  beforeEach(() => {
    cleanup();
    state.results = [];
    state.pending = false;
    state.debounce = undefined;
    state.search.mockClear();
  });
  it("renders page and attachment results and keeps ordinary search enabled", () => {
    state.results = [
      { id: "same-id", title: "Project plan" },
      { id: "same-id", fileName: "plan.pdf", title: "Attachment match" },
    ];
    render(<SearchSpotlight />);
    fireEvent.change(screen.getByLabelText("test query"), {
      target: { value: "plan" },
    });
    expect(screen.getByText("Project plan")).toBeTruthy();
    expect(screen.getByText("Attachment match")).toBeTruthy();
    expect(state.search).toHaveBeenLastCalledWith(
      { query: "plan", contentType: "all" },
      true,
    );
    expect(screen.queryByText("Ask")).toBeNull();
  });
  it("changes the requested space through the existing filter flow", () => {
    render(<SearchSpotlight />);
    fireEvent.click(screen.getByText("Change space"));
    expect(state.search).toHaveBeenLastCalledWith(
      { query: "", contentType: "all", spaceId: "second-space" },
      true,
    );
  });
  it("does not announce an empty result while the new query is still debouncing", () => {
    state.debounce = "";
    render(<SearchSpotlight />);
    fireEvent.change(screen.getByLabelText("test query"), {
      target: { value: "new query" },
    });
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByText("No results found...")).toBeNull();
  });
});
