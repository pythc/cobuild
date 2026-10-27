import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client";
import { ISpace } from "../types/space.types";

export function usePersonalKnowledgeQuery() {
  return useQuery({
    queryKey: ["personal-knowledge"],
    queryFn: async () => (await api.post<ISpace>("/spaces/personal")).data,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
