import React, { useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import {
  AlertTriangle,
  Copy,
  KeyRound,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Select,
  Table,
  Text,
  TextField, Box,
} from '@radix-ui/themes';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { useAuth } from '../contexts/AuthContext';
import ConfirmationDialog from '../components/ConfirmationDialog';
import ReauthDialog from '../components/ReauthDialog';
import { useConfirmation } from '../hooks/useConfirmation';
import { isReauthCancelledError, useReauth } from '../hooks/useReauth';
import {
  API_BASE_URL,
  type McpToken,
  type McpMintResponse,
  type McpTokenLifetime,
  type McpTokenScope,
} from '../services/api';
import { useMcpTokensQuery, useMintMcpTokenMutation, useRevokeMcpTokenMutation } from '../hooks/queries';
import { logger } from '../utils/logger';
import { PERSONAL_ACCESS_TOKEN_SCOPES, PERSONAL_ACCESS_TOKEN_SCOPE_LABELS as SCOPE_LABELS, vocabularyLabel, personalAccessTokenScope } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import PageContainer from '../components/PageContainer';

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

const LIFETIME_LABELS: Record<McpTokenLifetime, string> = {
  '30d': '30 days',
  '90d': '90 days',
  '365d': '1 year',
};

const DEFAULT_SCOPE: McpTokenScope = 'read';
const DEFAULT_LIFETIME: McpTokenLifetime = '365d';

const McpAccessPage: React.FC = () => {
  const tokensQuery = useMcpTokensQuery({ meta: { suppressErrorToast: true } });
  // `null` preserves the page's "still loading" state (no successful load yet).
  const tokens: McpToken[] | null = tokensQuery.data ?? null;
  const loadError = tokensQuery.error
    ? (tokensQuery.error instanceof Error ? tokensQuery.error.message : 'Failed to load tokens')
    : null;

  const mintTokenMutation = useMintMcpTokenMutation();
  const revokeTokenMutation = useRevokeMcpTokenMutation();
  const minting = mintTokenMutation.isPending;

  const { tenants, activeTenant } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('my-ai-agent');
  const [newTenantUuid, setNewTenantUuid] = useState<string>('');
  const [newScope, setNewScope] = useState<McpTokenScope>(DEFAULT_SCOPE);
  const [newLifetime, setNewLifetime] = useState<McpTokenLifetime>(DEFAULT_LIFETIME);
  const [mintResult, setMintResult] = useState<McpMintResponse | null>(null);
  const { confirmAsync, dialogProps } = useConfirmation();
  // Creating a token needs a fresh password/passkey confirmation; this prompts and retries.
  const { withReauth, dialogProps: reauthDialogProps } = useReauth();

  const handleMint = async () => {
    try {
      if (!newTenantUuid) {
        toast.error('Choose a ledger for the token');
        return;
      }
      const label = newLabel.trim() || 'mcp';
      const request = { label, tenantUuid: newTenantUuid, scope: newScope, expiresIn: newLifetime };
      const result = await withReauth(() => mintTokenMutation.mutateAsync(request));
      setMintResult(result);
      setCreateOpen(false);
      setNewLabel('my-ai-agent');
      setNewScope(DEFAULT_SCOPE);
      setNewLifetime(DEFAULT_LIFETIME);
      toast.success('Token created — copy it now, it won’t be shown again.');
    } catch (err) {
      if (isReauthCancelledError(err)) return; // the user closed the confirmation prompt
      logger.error({ err }, 'Failed to mint MCP token');
      toast.error(err instanceof Error ? err.message : 'Failed to create token');
    }
  };

  const handleRevoke = async (token: McpToken) => {
    const confirmed = await confirmAsync({
      title: `Revoke token "${token.label}"?`,
      message:
        'Any client using this token will stop working immediately. This cannot be undone, but you can always create a new token.',
      variant: 'warning',
      confirmText: 'Revoke Token',
      cancelText: 'Cancel',
      icon: <AlertTriangle size={24} />,
    });
    if (!confirmed) return;

    try {
      await revokeTokenMutation.mutateAsync(token.uuid);
      toast.success(`Revoked "${token.label}"`);
    } catch (err) {
      logger.error({ err, uuid: token.uuid }, 'Failed to revoke MCP token');
      toast.error(err instanceof Error ? err.message : 'Failed to revoke token');
    }
  };

  // Build an absolute URL for the MCP endpoint (works whether API_BASE_URL
  // is relative like "/api" or absolute like "https://api.example.com").
  const mcpUrl = useMemo(() => {
    const base = API_BASE_URL.startsWith('http')
      ? API_BASE_URL
      : `${window.location.origin}${API_BASE_URL.startsWith('/') ? API_BASE_URL : `/${API_BASE_URL}`}`;
    return `${base.replace(/\/$/, '')}/mcp`;
  }, []);

  // Claude Desktop’s claude_desktop_config.json currently only accepts stdio
  // servers, so we wrap our HTTP endpoint with the `mcp-remote` bridge.
  // The Bearer token lives in `env` (not in args) so it isn’t logged with
  // the command line.
  const claudeDesktopJson = useMemo(() => {
    if (!mintResult) return '';
    return JSON.stringify(
      {
        mcpServers: {
          nuggets: {
            command: 'npx',
            args: [
              '-y',
              'mcp-remote',
              mcpUrl,
              '--header',
              'Authorization:${AUTH_HEADER}',
            ],
            env: {
              AUTH_HEADER: `Bearer ${mintResult.token}`,
            },
          },
        },
      },
      null,
      2
    );
  }, [mintResult, mcpUrl]);

  // Claude Code (the CLI) accepts native HTTP transport, so we surface a
  // ready-to-run `claude mcp add` command alongside the Desktop config.
  const claudeCodeCommand = useMemo(() => {
    if (!mintResult) return '';
    return `claude mcp add --transport http nuggets ${mcpUrl} --header "Authorization: Bearer ${mintResult.token}"`;
  }, [mintResult, mcpUrl]);

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied to clipboard`);
    } catch {
      toast.error('Failed to copy — select and copy manually');
    }
  };

  return (
    <PageContainer>
      <SettingsPageHeader
        title="MCP Access"
        subtitle="Personal access tokens for connecting your AI agent (or any MCP client) to Nuggets"
        icon={<KeyRound size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        primaryAction={{
          label: 'New Token',
          onClick: () => {
            setNewTenantUuid(activeTenant?.uuid ?? tenants[0]?.uuid ?? '');
            setCreateOpen(true);
          },
          icon: <Plus size={16} />,
        }}
      />

      <Callout.Root color="blue" mb="5">
        <Callout.Icon>
          <KeyRound size={16} />
        </Callout.Icon>
        <Callout.Text>
          Tokens let MCP clients work with one ledger as you: read it, or read and change it.
          They can't sign in to the website, change your account or create more tokens. Treat
          them like passwords — the full token is shown only once, at creation time. Revoke any
          token here and the client stops working immediately.
        </Callout.Text>
      </Callout.Root>

      {loadError && (
        <Callout.Root color="red" mb="5">
          <Callout.Icon>
            <AlertTriangle size={16} />
          </Callout.Icon>
          <Callout.Text>{loadError}</Callout.Text>
        </Callout.Root>
      )}

      <Card>
        {tokens === null ? (
          <Flex justify="center" p="6">
            <Text size="2" color="gray">Loading tokens…</Text>
          </Flex>
        ) : tokens.length === 0 ? (
          <Flex direction="column" align="center" gap="2" p="6">
            <Text size="3" weight="bold">No active tokens</Text>
            <Text size="2" color="gray">
              Click “New Token” to mint one for your AI agent or another MCP client.
            </Text>
          </Flex>
        ) : (
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Label</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Ledger</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Access</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Audience</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Last used</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Expires</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {tokens.map((t) => (
                <Table.Row key={t.uuid}>
                  <Table.Cell>{t.label}</Table.Cell>
                  <Table.Cell>{t.tenantName}</Table.Cell>
                  <Table.Cell>
                    <Badge highContrast color={t.scope === personalAccessTokenScope.enum.read_write ? 'amber' : 'gray'} variant="soft">
                      {vocabularyLabel(SCOPE_LABELS, t.scope)}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color="blue" variant="soft">{t.audience}</Badge>
                  </Table.Cell>
                  <Table.Cell>{formatDate(t.createdAt)}</Table.Cell>
                  <Table.Cell>{formatDate(t.lastUsedAt)}</Table.Cell>
                  <Table.Cell>{formatDate(t.expiresAt)}</Table.Cell>
                  <Table.Cell>
                    <Button
                      size="1"
                      color="red"
                      variant="soft"
                      onClick={() => handleRevoke(t)}
                    >
                      <Trash2 size={14} />
                      Revoke
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </Card>

      {/* Create dialog */}
      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Content maxWidth="480px">
          <Dialog.Title>New MCP token</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            Give the token a recognisable label so you know what to revoke later.
          </Dialog.Description>

          <Flex direction="column" gap="2">
            <Text as="label" htmlFor="mcp-token-label" size="2" weight="medium">Label</Text>
            <TextField.Root
              id="mcp-token-label"
              placeholder="e.g. desktop-agent, home-laptop"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              maxLength={100}
            />
          </Flex>

          <Flex direction="column" gap="2" mt="3">
            <Text as="label" htmlFor="mcp-token-ledger" size="2" weight="medium">Ledger</Text>
            <Select.Root value={newTenantUuid} onValueChange={setNewTenantUuid}>
              <Select.Trigger id="mcp-token-ledger" placeholder="Choose a ledger" />
              <Select.Content>
                {tenants.map((t) => (
                  <Select.Item key={t.uuid} value={t.uuid}>
                    {t.name} · {t.organizationName}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Text size="1" color="gray">
              The token works only in this ledger.
            </Text>
          </Flex>

          <Flex direction="column" gap="2" mt="3">
            <Text size="2" weight="medium" id="mcp-token-scope-label">Access</Text>
            <Select.Root value={newScope} onValueChange={(v) => setNewScope(oneOf(PERSONAL_ACCESS_TOKEN_SCOPES, v) ?? DEFAULT_SCOPE)}>
              <Select.Trigger aria-labelledby="mcp-token-scope-label" />
              <Select.Content>
                {PERSONAL_ACCESS_TOKEN_SCOPES.map((scope) => (
                  <Select.Item key={scope} value={scope}>{SCOPE_LABELS[scope]}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Text size="1" color="gray">
              {newScope === personalAccessTokenScope.enum.read
                ? 'The client can look at this ledger but not change anything; its write tools are refused.'
                : 'The client can also add and change transactions, budget items, merchants, tags and more.'}
            </Text>
          </Flex>

          <Flex direction="column" gap="2" mt="3">
            <Text size="2" weight="medium" id="mcp-token-lifetime-label">Expires after</Text>
            <Select.Root value={newLifetime} onValueChange={(v) => setNewLifetime(v as McpTokenLifetime)}>
              <Select.Trigger aria-labelledby="mcp-token-lifetime-label" />
              <Select.Content>
                {(Object.keys(LIFETIME_LABELS) as McpTokenLifetime[]).map((lifetime) => (
                  <Select.Item key={lifetime} value={lifetime}>
                    {LIFETIME_LABELS[lifetime]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Flex gap="3" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={minting}>Cancel</Button>
            </Dialog.Close>
            <Button onClick={handleMint} disabled={minting} loading={minting}>
              Create token
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* Post-mint “one-shot” display */}
      <Dialog.Root open={mintResult !== null} onOpenChange={(open) => !open && setMintResult(null)}>
        <Dialog.Content maxWidth="640px">
          <Dialog.Title>Your new token</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            Copy the token now — for security it will not be shown again. You can always revoke
            it and create a new one.
          </Dialog.Description>

          {mintResult && (
            <Flex direction="column" gap="4">
              <Flex direction="column" gap="2">
                <Flex justify="between" align="center">
                  <Text size="2" weight="medium">Token</Text>
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => copyToClipboard(mintResult.token, 'Token')}
                  >
                    <Copy size={14} /> Copy
                  </Button>
                </Flex>
                <Box asChild p="3" overflowX="auto"><pre className="bg-[var(--gray-3)] rounded-[var(--radius-2)] text-xs break-all whitespace-pre-wrap">
                  {mintResult.token}
                </pre></Box>
              </Flex>

              <Text size="2" color="gray">
                Any MCP client can connect with the server URL and this token. Setup for two
                clients follows as examples.
              </Text>

              <Flex direction="column" gap="2">
                <Flex justify="between" align="center">
                  <Text size="2" weight="medium">Claude Desktop config snippet</Text>
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => copyToClipboard(claudeDesktopJson, 'Config')}
                  >
                    <Copy size={14} /> Copy
                  </Button>
                </Flex>
                <Text size="1" color="gray">
                  Paste inside <code>mcpServers</code> in your{' '}
                  <code>claude_desktop_config.json</code>. Uses the{' '}
                  <code>mcp-remote</code> bridge because Claude Desktop only loads stdio
                  servers; <code>npx</code> downloads it on first run, so Node.js must be
                  installed on your machine.
                </Text>
                <Box asChild p="3" overflowX="auto"><pre className="bg-[var(--gray-3)] rounded-[var(--radius-2)] text-xs">
                  {claudeDesktopJson}
                </pre></Box>
              </Flex>

              <Flex direction="column" gap="2">
                <Flex justify="between" align="center">
                  <Text size="2" weight="medium">Claude Code (CLI) command</Text>
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => copyToClipboard(claudeCodeCommand, 'Command')}
                  >
                    <Copy size={14} /> Copy
                  </Button>
                </Flex>
                <Text size="1" color="gray">
                  Run once in a terminal. Claude Code speaks HTTP MCP natively, so no
                  bridge is needed.
                </Text>
                <Box asChild p="3" overflowX="auto"><pre className="bg-[var(--gray-3)] rounded-[var(--radius-2)] text-xs break-all whitespace-pre-wrap">
                  {claudeCodeCommand}
                </pre></Box>
              </Flex>
            </Flex>
          )}

          <Flex justify="end" mt="4">
            <Dialog.Close>
              <Button>Done</Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmationDialog {...dialogProps} />
      <ReauthDialog {...reauthDialogProps} />
    </PageContainer>
  );
};

export default McpAccessPage;
