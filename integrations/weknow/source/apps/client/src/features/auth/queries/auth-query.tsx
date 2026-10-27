import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { getCollabToken, verifyUserToken } from "../services/auth-service";
import { ICollabToken, IVerifyUserToken } from "../types/auth.types";
import { isAxiosError } from "axios";

export function useVerifyUserTokenQuery(
  verify: IVerifyUserToken,
): UseQueryResult<any, Error> {
  return useQuery({
    queryKey: ["verify-token", verify],
    queryFn: () => verifyUserToken(verify),
    enabled: !!verify.token,
    staleTime: 0,
  });
}

export function useCollabToken(): UseQueryResult<ICollabToken, Error> {
  return useQuery({
    queryKey: ["collab-token"],
    queryFn: () => getCollabToken(),
    staleTime: 20 * 60 * 60 * 1000, //20hrs
    //refetchInterval: 12 * 60 * 60 * 1000, // 12hrs
    //refetchIntervalInBackground: true,
    refetchOnMount: true,
    retry: (failureCount, error) => {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      if (status && status < 500 && status !== 429) return false;
      return failureCount < 6;
    },
    retryDelay: (retryAttempt) => {
      return Math.min(1000 * 2 ** retryAttempt, 30_000);
    },
  });
}
