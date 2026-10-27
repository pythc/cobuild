import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { saveStateAtom } from "@/features/editor/save-state";
import { UserProvider } from "./user-provider";
const state = vi.hoisted(() => ({ query: {} as any }));
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: () => state.query,
}));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({ data: null }),
}));
vi.mock("@/features/websocket/use-query-subscription.ts", () => ({
  useQuerySubscription: () => {},
}));
vi.mock("@/features/websocket/use-tree-socket.ts", () => ({
  useTreeSocket: () => {},
}));
vi.mock("@/features/notification/hooks/use-notification-socket.ts", () => ({
  useNotificationSocket: () => {},
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { changeLanguage: () => {}, language: "zh-CN" },
  }),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: () => {},
    off: () => {},
    disconnect: () => {},
    connect: () => {},
  }),
}));
vi.mock("@/pages/auth/login-continuation", () => ({
  clearAutomaticLogin: () => {},
}));
vi.mock("@/components/ui/error-404.tsx", () => ({ Error404: () => null }));
afterEach(() => {
  cleanup();
  getDefaultStore().set(saveStateAtom, {
    pageId: "",
    phase: "loading",
    localSaved: false,
  });
});
describe("editor survives background identity failures", () => {
  it("keeps the same mounted editing field on a 401, then recovers", () => {
    const data = { user: { id: "u", locale: "zh-CN" }, workspace: { id: "w" } };
    state.query = { data, isLoading: false, isError: false };
    getDefaultStore().set(saveStateAtom, {
      pageId: "open-doc",
      phase: "auth",
      localSaved: true,
    });
    const q = new QueryClient();
    const view = () => (
      <QueryClientProvider client={q}>
        <UserProvider>
          <textarea aria-label="draft" defaultValue="尚未完成的原文" />
        </UserProvider>
      </QueryClientProvider>
    );
    const r = render(view()),
      field = r.getByLabelText("draft");
    state.query = {
      data,
      isLoading: false,
      isError: true,
      error: { response: { status: 401 } },
    };
    r.rerender(view());
    expect(r.getByLabelText("draft")).toBe(field);
    state.query = { data, isLoading: false, isError: false };
    r.rerender(view());
    expect(r.getByLabelText("draft")).toBe(field);
  });
  it("does not expose protected content on an unauthenticated first visit", () => {
    state.query = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { response: { status: 401 } },
    };
    const r = render(
      <QueryClientProvider client={new QueryClient()}>
        <UserProvider>
          <div>protected body</div>
        </UserProvider>
      </QueryClientProvider>,
    );
    expect(r.queryByText("protected body")).toBeNull();
  });
});
