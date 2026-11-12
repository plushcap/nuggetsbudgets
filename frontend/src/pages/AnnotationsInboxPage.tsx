import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Box, Flex, Card, Text, Badge, Button, SegmentedControl, Switch } from '@radix-ui/themes';
import { Bot, User as UserIcon, MessageSquare, Check, CheckCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import ConfirmationDialog from '../components/ConfirmationDialog';
import { useConfirmation } from '../hooks/useConfirmation';
import {
  useAnnotationThreadsQuery,
  useManuallyResolveAnnotationsMutation,
} from '../hooks/queries/annotations';
import type { AnnotationThread } from '../services/api/annotations';
import { ANNOTATION_STATUS_LABELS, type AnnotationStatus, annotationAuthorKind, annotationStatus, annotationSubjectType, transactionReviewStatus } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import PageContainer from '../components/PageContainer';

/** The statuses the inbox filters by (the server's values), and all of them. */
const INBOX_STATUSES: AnnotationStatus[] = ['open', 'answered', 'resolved'];
const INBOX_FILTERS: (AnnotationStatus | 'all')[] = [...INBOX_STATUSES, 'all'];

type BadgeColor = React.ComponentProps<typeof Badge>['color'];

const KIND_COLOR: Record<string, BadgeColor> = {
  question: 'amber',
  answer: 'green',
  decision: 'blue',
  reasoning: 'gray',
  observation: 'gray',
  correction: 'purple',
  flag: 'red',
  note: 'gray',
};

// Review state of the subject transaction. Semantic colors (not the accent) so
// "needs review" reads as outstanding at a glance.
const REVIEW_COLOR: Record<string, BadgeColor> = {
  reviewed: 'green',
  'needs review': 'amber',
  flagged: 'red',
};

const recordHref = (t: AnnotationThread): string | null =>
  t.subject_type === annotationSubjectType.enum.transaction && t.subject_uuid ? `/transactions/${t.subject_uuid}` : null;

const ThreadRow: React.FC<{
  t: AnnotationThread;
  onResolve: (t: AnnotationThread) => void;
  resolving: boolean;
}> = ({ t, onResolve, resolving }) => {
  const href = recordHref(t);
  const isOpen = t.status === annotationStatus.enum.open;

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2" wrap="wrap">
          {t.author_kind === annotationAuthorKind.enum.agent ? (
            <Bot size={16} className="text-[var(--accent-11)]" />
          ) : (
            <UserIcon size={16} className="text-[var(--gray-11)]" />
          )}
          <Badge color={KIND_COLOR[t.kind] ?? 'gray'} variant="soft" size="1">{t.kind}</Badge>
          {t.notify && <Badge highContrast color="amber" variant="surface" size="1">notify</Badge>}
          <Badge color="gray" variant="surface" size="1">{t.status}</Badge>
          {t.subject_review_status && (
            <Badge color={REVIEW_COLOR[t.subject_review_status] ?? 'gray'} variant="soft" size="1">
              {t.subject_review_status}
            </Badge>
          )}
          {t.reply_count > 0 && (
            <Flex align="center" gap="1">
              <MessageSquare size={12} className="text-[var(--gray-11)]" />
              <Text size="1" color="gray">{t.reply_count}</Text>
            </Flex>
          )}
          <Box flexGrow="1" />
          <Text size="1" color="gray">{new Date(t.created_at).toLocaleString()}</Text>
          {isOpen && (
            <Button
              size="1"
              variant="soft"
              color="green"
              onClick={() => onResolve(t)}
              disabled={resolving}
            >
              <Check size={12} />
              Resolve
            </Button>
          )}
        </Flex>

        {/* The record link wraps the text only — a button nested inside an
            anchor is invalid markup and swallows the click. */}
        {href ? (
          <Link to={href} className="text-inherit" style={{ textDecoration: 'none' }}>
            <Text as="div" size="2" color="gray" highContrast className="line-clamp-2">{t.body}</Text>
          </Link>
        ) : (
          <Text as="div" size="2" color="gray" highContrast className="line-clamp-2">{t.body}</Text>
        )}

        {t.subject_label && (
          <Text size="1" color="gray">
            {t.subject_type}: {t.subject_label}
            {t.subject_budget_item_name ? ` · ${t.subject_budget_item_name}` : ''}
          </Text>
        )}
      </Flex>
    </Card>
  );
};

export const AnnotationsInboxPage: React.FC = () => {
  const [status, setStatus] = useState<AnnotationStatus | 'all'>('open');
  const [notifyOnly, setNotifyOnly] = useState(false);
  const { confirmAsync, dialogProps } = useConfirmation();

  const { data, isLoading } = useAnnotationThreadsQuery({
    ...(status === 'all' ? {} : { status }),
    notify: notifyOnly,
    limit: 100,
  });
  const threads = useMemo(() => data?.threads ?? [], [data]);
  const resolveMutation = useManuallyResolveAnnotationsMutation();

  // The bulk actions always act on every OPEN thread tenant-wide (the server
  // scopes them), not just the page's current filter — so only offer them when
  // there is something open in view to avoid implying a no-op did something.
  const openInView = threads.filter((t) => t.status === annotationStatus.enum.open);
  const reviewedOpenInView = openInView.filter((t) => t.subject_review_status === transactionReviewStatus.enum.reviewed);

  const runResolve = async (
    input: { uuid: string } | { scope: 'all' | 'reviewed' },
    successVerb: string,
  ) => {
    try {
      const { resolved } = await resolveMutation.mutateAsync(input);
      toast.success(
        resolved === 0
          ? 'Nothing open to resolve'
          : `${successVerb} ${resolved} ${resolved === 1 ? 'activity' : 'activities'}`,
      );
    } catch {
      toast.error('Failed to resolve activity');
    }
  };

  const handleResolveOne = (t: AnnotationThread) => {
    void runResolve({ uuid: t.uuid }, 'Resolved');
  };

  const handleResolveAll = async () => {
    const confirmed = await confirmAsync({
      title: 'Resolve all open activities',
      message:
        'Every open activity will get a reply recording that you resolved it manually, and will be marked answered. This applies to all open activities, not just the ones shown.',
      confirmText: 'Resolve all',
      variant: 'warning',
    });
    if (confirmed) await runResolve({ scope: 'all' }, 'Resolved');
  };

  const handleResolveReviewed = async () => {
    const confirmed = await confirmAsync({
      title: 'Resolve activities on reviewed transactions',
      message:
        'Open activities whose transaction is already marked reviewed will get a reply recording that you resolved them manually, and will be marked answered.',
      confirmText: 'Resolve reviewed',
      variant: 'warning',
    });
    if (confirmed) await runResolve({ scope: 'reviewed' }, 'Resolved');
  };

  return (
    <PageContainer>
      <PageHeader title="Activity" subtitle="Agent reasoning, questions, and discussions across your records" />

      <Flex align="center" gap="4" mb="4" wrap="wrap">
        <SegmentedControl.Root
          aria-label="Status"
          value={status}
          onValueChange={(value) => setStatus(oneOf(INBOX_FILTERS, value) ?? 'open')}
        >
          {INBOX_STATUSES.map((s) => (
            <SegmentedControl.Item key={s} value={s}>{ANNOTATION_STATUS_LABELS[s]}</SegmentedControl.Item>
          ))}
          <SegmentedControl.Item value="all">All</SegmentedControl.Item>
        </SegmentedControl.Root>
        <Text as="label" size="2">
          <Flex align="center" gap="2">
            <Switch checked={notifyOnly} onCheckedChange={setNotifyOnly} />
            Needs attention only
          </Flex>
        </Text>

        <Box flexGrow="1" />

        <Button
          variant="soft"
          color="green"
          onClick={handleResolveReviewed}
          disabled={resolveMutation.isPending || reviewedOpenInView.length === 0}
        >
          <Check size={16} />
          Resolve reviewed
        </Button>
        <Button
          variant="soft"
          color="green"
          onClick={handleResolveAll}
          disabled={resolveMutation.isPending || openInView.length === 0}
        >
          <CheckCheck size={16} />
          Resolve all open
        </Button>
      </Flex>

      {isLoading ? (
        <PageLoader label="Loading activity…" />
      ) : threads.length === 0 ? (
        <Card>
          <Text size="2" color="gray">Nothing here. Agent questions and notes will show up as they appear.</Text>
        </Card>
      ) : (
        <Flex direction="column" gap="3">
          {threads.map((t) => (
            <ThreadRow
              key={t.uuid}
              t={t}
              onResolve={handleResolveOne}
              resolving={resolveMutation.isPending}
            />
          ))}
        </Flex>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default AnnotationsInboxPage;
