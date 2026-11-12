import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMcpTokens, mintMcpToken, revokeMcpToken, type McpMintRequest } from '../../services/api';

type QueryOverrides = { meta?: Record<string, unknown>; staleTime?: number; enabled?: boolean };

const mcpKeys = {
  all: ['mcpTokens'] as const,
};

/**
 * Personal MCP access tokens for the current user. The page renders its own
 * inline error callout, so the global error toast is suppressed.
 */
export function useMcpTokensQuery(options?: QueryOverrides) {
  return useQuery({ queryKey: mcpKeys.all, queryFn: getMcpTokens, ...options });
}

export function useMintMcpTokenMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: McpMintRequest) => mintMcpToken(args),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mcpKeys.all }),
  });
}

export function useRevokeMcpTokenMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => revokeMcpToken(uuid),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mcpKeys.all }),
  });
}
