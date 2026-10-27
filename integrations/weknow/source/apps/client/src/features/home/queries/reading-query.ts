import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { userAtom } from "@/features/user/atoms/current-user-atom";
import api from "@/lib/api-client";
export interface ReadingPage {
  id: string;
  slugId: string;
  title: string;
  icon: string;
  lastReadAt: string;
  nodeType?: string;
  fileExtension?: string;
  space: { id: string; name: string; slug: string };
}
export function useReadingQuery() {
  const user = useAtomValue(userAtom);
  return useQuery({
    queryKey: ["page-reading", user?.workspaceId, user?.id],
    queryFn: async () =>
      (await api.post<{ items: ReadingPage[] }>("/pages/reading")).data,
    enabled: !!user,
    refetchOnMount: "always",
  });
}
