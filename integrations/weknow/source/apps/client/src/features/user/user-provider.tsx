import { saveStateAtom } from "@/features/editor/save-state";
import { useQueryClient } from "@tanstack/react-query";
import localEmitter from "@/lib/local-emitter";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import React, { useEffect } from "react";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useTranslation } from "react-i18next";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { io } from "socket.io-client";
import { SOCKET_URL } from "@/features/websocket/types";
import { useQuerySubscription } from "@/features/websocket/use-query-subscription.ts";
import { useTreeSocket } from "@/features/websocket/use-tree-socket.ts";
import { useNotificationSocket } from "@/features/notification/hooks/use-notification-socket.ts";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { clearAutomaticLogin } from "@/pages/auth/login-continuation";

export function UserProvider({ children }: React.PropsWithChildren) {
  const queryClient = useQueryClient();
  const saveState = useAtomValue(saveStateAtom);
  const [, setCurrentUser] = useAtom(currentUserAtom);
  const { data, isLoading, error, isError } = useCurrentUser();
  const { i18n } = useTranslation();
  const [, setSocket] = useAtom(socketAtom);
  // fetch collab token on load
  const { data: collab } = useCollabToken();

  useEffect(() => {
    if (isLoading || isError) {
      return;
    }

    const newSocket = io(SOCKET_URL, {
      transports: ["websocket"],
      withCredentials: true,
    });

    // @ts-ignore
    setSocket(newSocket);

    let retry: ReturnType<typeof setTimeout>,
      backoff = 2000;
    const refreshTree = () => localEmitter.emit("page-tree-refresh", {});
    const ready = () => {
      backoff = 2000;
      clearTimeout(retry);
      refreshTree();
    };
    const unavailable = () => {
      clearTimeout(retry);
      retry = setTimeout(() => {
        newSocket.connect();
      }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    const unauthorized = () => {
      clearTimeout(retry);
      void queryClient.invalidateQueries({ queryKey: ["currentUser"] });
    };
    newSocket.on("connect", refreshTree);
    newSocket.on("Ready", ready);
    newSocket.on("SessionUnavailable", unavailable);
    newSocket.on("Unauthorized", unauthorized);

    return () => {
      clearTimeout(retry);
      newSocket.off("connect", refreshTree);
      newSocket.off("Ready", ready);
      newSocket.off("SessionUnavailable", unavailable);
      newSocket.off("Unauthorized", unauthorized);
      newSocket.disconnect();
      setSocket(null);
    };
  }, [isError, isLoading, queryClient, setSocket]);

  useQuerySubscription();
  useTreeSocket();
  useNotificationSocket();

  useEffect(() => {
    if (data && data.user && data.workspace) {
      try {
        clearAutomaticLogin(window.sessionStorage);
      } catch {
        /* Restricted storage. */
      }
      setCurrentUser(data);
      i18n.changeLanguage(
        data.user.locale === "en" ? "en-US" : data.user.locale,
      );
    }
  }, [data, isLoading]);

  useEffect(() => {
    document.documentElement.lang =
      i18n.resolvedLanguage || i18n.language || "en-US";
  }, [i18n.language, i18n.resolvedLanguage]);

  if (isLoading) return <></>;

  // A failed background identity refresh must not unmount an already-open
  // editor. Its status UI provides recovery and a download of the local copy.
  const retainEditor = Boolean(data?.user && saveState.pageId);
  if (isError && !retainEditor && error?.["response"]?.status === 404) {
    return <Error404 />;
  }

  if (error && !retainEditor) {
    return <></>;
  }

  return <>{children}</>;
}
