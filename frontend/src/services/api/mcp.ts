/**
 * API MCP Module — personal access tokens for MCP clients (AI agents such as Claude Desktop).
 */
import {
  PERSONAL_ACCESS_TOKEN_LIFETIMES,
  personalAccessTokenListResponseSchema,
  personalAccessTokenMintedResponseSchema,
  personalAccessTokenRevokedResponseSchema,
  type PersonalAccessTokenMinted,
  type PersonalAccessTokenScope,
  type PersonalAccessTokenSummary,
} from '@nuggets/shared';
import { apiGet, apiPost, apiDelete } from './base';
import { parseAnswer } from './parseAnswer';

/** What a token may do in its ledger: read only, or read and change data (personal_access_tokens.scope). */
export type McpTokenScope = PersonalAccessTokenScope;
/** How long a new token lasts. */
export type McpTokenLifetime = (typeof PERSONAL_ACCESS_TOKEN_LIFETIMES)[number];

/** A token that still works, as its owner lists it: never the token itself. */
export type McpToken = PersonalAccessTokenSummary;

/** A new token: `token` is shown only now. */
export type McpMintResponse = PersonalAccessTokenMinted;

export interface McpMintRequest {
  label: string;
  tenantUuid: string;
  scope: McpTokenScope;
  expiresIn: McpTokenLifetime;
}

export const getMcpTokens = async (): Promise<McpToken[]> =>
  parseAnswer(personalAccessTokenListResponseSchema, await apiGet<unknown>('/auth/mcp-tokens'), 'tokens');

/** Needs a fresh re-authentication: rejects with code REAUTH_REQUIRED otherwise. */
export const mintMcpToken = async (request: McpMintRequest): Promise<McpMintResponse> =>
  parseAnswer(personalAccessTokenMintedResponseSchema, await apiPost<unknown>('/auth/mcp-token', request), 'token minted');

export const revokeMcpToken = async (uuid: string) =>
  parseAnswer(personalAccessTokenRevokedResponseSchema, await apiDelete<unknown>(`/auth/mcp-tokens/${uuid}`), 'token revoked');
