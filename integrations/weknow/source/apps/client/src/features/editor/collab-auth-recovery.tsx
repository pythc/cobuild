import { useEffect } from "react";
import { useHocuspocusProvider } from "@hocuspocus/provider-react";
import { CollabAuthRetry } from "./collab-auth-retry";

export function CollabAuthRecovery() {
  const provider = useHocuspocusProvider();
  useEffect(() => {
    const retry = new CollabAuthRetry(() => {
      if (provider.isAuthenticated) return;
      // The server discarded unauthenticated sync packets. Start a complete Yjs
      // handshake again so local edits made before the outage are reconciled.
      void provider.sendToken().then(() => provider.startSync());
    });
    const failed = ({ reason }: { reason: string }) => retry.failed(reason);
    const closed = ({ event }: { event: { reason: string } }) =>
      retry.failed(event.reason);
    const authenticated = () => retry.reset();
    provider.on("authenticationFailed", failed);
    provider.on("close", closed);
    provider.on("authenticated", authenticated);
    return () => {
      retry.dispose();
      provider.off("authenticationFailed", failed);
      provider.off("close", closed);
      provider.off("authenticated", authenticated);
    };
  }, [provider]);
  return null;
}
