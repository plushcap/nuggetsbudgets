import React, { useMemo, useState } from 'react';
import { Card, Flex, Box, Text, Heading, TextArea, TextField, Select, Button, Badge, Separator, Callout } from '@radix-ui/themes';
import { Bot, User as UserIcon, MessageSquare, CornerDownRight, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useAnnotationsQuery, useCreateAnnotationMutation, useUpdateAnnotationMutation } from '../hooks/queries/annotations';
import type { Annotation } from '../services/api/annotations';
import { ANNOTATION_KINDS, ANNOTATION_KIND_LABELS, annotationAuthorKind, annotationFeedback, annotationLearningStatus, annotationStatus, type AnnotationKind, type AnnotationSubjectType } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import toast from 'react-hot-toast';

interface RecordActivityProps {
  subjectType: AnnotationSubjectType;
  subjectUuid: string;
}

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

// Kinds a human can post from the composer (agent-only kinds are omitted).
const HUMAN_KINDS: AnnotationKind[] = ['note', 'answer', 'question', 'observation'];

const authorLabel = (a: Annotation): string => {
  if (a.author_kind === annotationAuthorKind.enum.agent) return a.agent_name || 'Agent';
  if (a.author_kind === annotationAuthorKind.enum.system) return 'System';
  return a.author_first_name || 'User';
};

const formatWhen = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

const AnnotationEntry: React.FC<{ a: Annotation; isReply?: boolean }> = ({ a, isReply }) => (
  <Box pl={isReply ? '5' : '0'}>
    <Flex gap="2" align="center" mb="1" wrap="wrap">
      {a.author_kind === annotationAuthorKind.enum.agent ? (
        <Bot size={16} className="text-[var(--accent-11)]" />
      ) : (
        <UserIcon size={16} className="text-[var(--gray-11)]" />
      )}
      <Text size="2" weight="medium">{authorLabel(a)}</Text>
      <Badge color={KIND_COLOR[a.kind] ?? 'gray'} variant="soft" size="1">{a.kind}</Badge>
      {!isReply && a.status !== annotationStatus.enum.open && (
        <Badge color="gray" variant="surface" size="1">{a.status}</Badge>
      )}
      {!isReply && a.feedback === annotationFeedback.enum.incorrect && (
        <Badge color="red" variant="soft" size="1">marked incorrect</Badge>
      )}
      {!isReply && a.feedback === annotationFeedback.enum.correct && (
        <Badge highContrast color="green" variant="soft" size="1">confirmed</Badge>
      )}
      {!isReply && a.learning_status === annotationLearningStatus.enum.pending && (
        <Badge highContrast color="amber" variant="surface" size="1">learning pending</Badge>
      )}
      {!isReply && a.learning_status === annotationLearningStatus.enum.applied && (
        <Badge highContrast color="green" variant="surface" size="1">learned</Badge>
      )}
      {a.edited && <Text size="1" color="gray">(edited)</Text>}
      <Text size="1" color="gray">{formatWhen(a.created_at)}</Text>
    </Flex>
    <Text size="2" color="gray" highContrast style={{ whiteSpace: 'pre-wrap' }}>{a.body}</Text>
    {!isReply && a.feedback === annotationFeedback.enum.incorrect && a.feedback_reason && (
      <Text size="1" color="red">Reason: {a.feedback_reason}</Text>
    )}
  </Box>
);

export const RecordActivity: React.FC<RecordActivityProps> = ({ subjectType, subjectUuid }) => {
  const { data, isLoading } = useAnnotationsQuery(subjectType, subjectUuid);
  const createMutation = useCreateAnnotationMutation();
  const updateMutation = useUpdateAnnotationMutation();

  const [body, setBody] = useState('');
  const [kind, setKind] = useState<AnnotationKind>('note');
  const [replyTo, setReplyTo] = useState<Annotation | null>(null);
  const [flagFor, setFlagFor] = useState<string | null>(null);
  const [flagReason, setFlagReason] = useState('');

  const annotations = useMemo(() => data?.annotations ?? [], [data]);

  // Group into threads: roots (no parent) with their replies, preserving order.
  const threads = useMemo(() => {
    const roots = annotations.filter((a) => !a.parent_uuid);
    const childrenByParent = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (a.parent_uuid) {
        const list = childrenByParent.get(a.parent_uuid) ?? [];
        list.push(a);
        childrenByParent.set(a.parent_uuid, list);
      }
    }
    return roots.map((root) => ({ root, replies: childrenByParent.get(root.uuid) ?? [] }));
  }, [annotations]);

  const handlePost = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    createMutation.mutate(
      replyTo
        ? { parent_uuid: replyTo.uuid, kind, body: trimmed }
        : { subject_type: subjectType, subject_uuid: subjectUuid, kind, body: trimmed },
      {
        onSuccess: () => {
          setBody('');
          setKind('note');
          setReplyTo(null);
        },
        onError: () => toast.error('Could not post your message'),
      },
    );
  };

  return (
    <Card>
      <Flex direction="column" gap="3">
        <Flex align="center" gap="2">
          <MessageSquare size={16} className="text-[var(--gray-11)]" />
          <Heading as="h3" size="3">Activity</Heading>
          {annotations.length > 0 && (
            <Badge color="gray" variant="soft" size="1">{annotations.length}</Badge>
          )}
        </Flex>

        {isLoading ? (
          <Text size="2" color="gray">Loading activity…</Text>
        ) : threads.length === 0 ? (
          <Text size="2" color="gray">
            No activity yet. Notes and agent reasoning for this record will appear here.
          </Text>
        ) : (
          <Flex direction="column" gap="3">
            {threads.map(({ root, replies }) => (
              <Box key={root.uuid}>
                <AnnotationEntry a={root} />
                {replies.map((r) => (
                  <Box key={r.uuid} mt="2"><AnnotationEntry a={r} isReply /></Box>
                ))}
                <Flex mt="1" gap="2" align="center" wrap="wrap">
                  <Button
                    type="button"
                    variant="ghost"
                    color="gray"
                    size="1"
                    onClick={() => setReplyTo(root)}
                  >
                    <CornerDownRight size={12} />
                    Reply
                  </Button>
                  {root.status === annotationStatus.enum.resolved ? (
                    <Button
                      type="button"
                      variant="ghost"
                      color="gray"
                      size="1"
                      onClick={() => updateMutation.mutate({ uuid: root.uuid, updates: { status: 'open' } })}
                      disabled={updateMutation.isPending}
                    >
                      Reopen
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      color="green"
                      size="1"
                      onClick={() => updateMutation.mutate({ uuid: root.uuid, updates: { status: 'resolved' } })}
                      disabled={updateMutation.isPending}
                    >
                      <Check size={12} />
                      Resolve
                    </Button>
                  )}
                  {/* Feedback on an agent decision drives the learning loop. */}
                  {root.author_kind === annotationAuthorKind.enum.agent && !root.feedback && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        color="green"
                        size="1"
                        onClick={() => updateMutation.mutate({ uuid: root.uuid, updates: { feedback: 'correct' } })}
                        disabled={updateMutation.isPending}
                      >
                        <ThumbsUp size={12} />
                        Looks good
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        color="red"
                        size="1"
                        onClick={() => { setFlagFor(root.uuid); setFlagReason(''); }}
                      >
                        <ThumbsDown size={12} />
                        Flag incorrect
                      </Button>
                    </>
                  )}
                </Flex>
                {flagFor === root.uuid && (
                  <Flex mt="2" gap="2" align="center" wrap="wrap">
                    <TextField.Root
                      aria-label="Why is this incorrect?"
                      placeholder="Why is this incorrect? (helps the agent learn)"
                      value={flagReason}
                      onChange={(e) => setFlagReason(e.target.value)}
                      style={{ flex: 1, minWidth: '200px' }}
                    />
                    <Button
                      type="button"
                      color="red"
                      size="1"
                      disabled={!flagReason.trim() || updateMutation.isPending}
                      onClick={() => {
                        updateMutation.mutate(
                          { uuid: root.uuid, updates: { feedback: 'incorrect', feedback_reason: flagReason.trim() } },
                          { onSuccess: () => { setFlagFor(null); setFlagReason(''); } },
                        );
                      }}
                    >
                      Submit
                    </Button>
                    <Button type="button" variant="soft" color="gray" size="1" onClick={() => setFlagFor(null)}>
                      Cancel
                    </Button>
                  </Flex>
                )}
                <Separator my="3" size="4" />
              </Box>
            ))}
          </Flex>
        )}

        {/* Composer */}
        <Flex direction="column" gap="2">
          {replyTo && (
            <Flex align="center" justify="between" gap="2">
              <Callout.Root size="1" color="gray" style={{ flex: 1 }}>
                <Callout.Text>Replying to {authorLabel(replyTo)}.</Callout.Text>
              </Callout.Root>
              <Button type="button" variant="soft" color="gray" size="1" onClick={() => setReplyTo(null)}>
                Cancel
              </Button>
            </Flex>
          )}
          <TextArea
            aria-label={replyTo ? 'Reply' : 'New entry'}
            placeholder="Add a note, answer, or question…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
          />
          <Flex gap="2" justify="between" align="center" wrap="wrap">
            <Select.Root value={kind} onValueChange={(value) => setKind(oneOf(ANNOTATION_KINDS, value) ?? 'note')}>
              <Select.Trigger aria-label="Entry type" />
              <Select.Content>
                {HUMAN_KINDS.map((k) => (
                  <Select.Item key={k} value={k}>{ANNOTATION_KIND_LABELS[k]}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Button type="button" onClick={handlePost} disabled={!body.trim() || createMutation.isPending}>
              {replyTo ? 'Reply' : 'Post'}
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
};

export default RecordActivity;
