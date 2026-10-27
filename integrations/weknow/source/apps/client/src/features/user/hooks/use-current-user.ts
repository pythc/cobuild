import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { getMyInfo } from "@/features/user/services/user-service";
import { ICurrentUser } from "@/features/user/types/user.types";

export default function useCurrentUser(): UseQueryResult<ICurrentUser> {
  return useQuery({
    queryKey: ["currentUser"],
    refetchInterval: 60000,
    queryFn: async () => {
      return await getMyInfo();
    },
  });
}
