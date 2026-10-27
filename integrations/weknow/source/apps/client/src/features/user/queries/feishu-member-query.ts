import { useQuery } from "@tanstack/react-query";

export function useFeishuMember(userId: string, enabled = true) {
  return useQuery({
    queryKey: ["feishu-member", userId],
    enabled: enabled && !!userId,
    staleTime: 60000,
    refetchInterval: 60000,
    queryFn: async ({ signal }) => {
      const r = await fetch("/api/integrations/feishu/member", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal,
        body: JSON.stringify({ userId }),
      });
      if (!r.ok) throw new Error("无法读取成员信息");
      const result = await r.json();
      return (
        Object.prototype.hasOwnProperty.call(result, "data")
          ? result.data
          : result
      ) as {
        id: string;
        name: string;
        avatarUrl: string;
        active: boolean;
      } | null;
    },
  });
}
