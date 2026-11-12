import React from 'react';
import { Callout, Flex, Box, Text, Button } from '@radix-ui/themes';
import { Bot, TriangleAlert } from 'lucide-react';
import { useAnnotationsQuery, useUpdateAnnotationMutation } from '../hooks/queries/annotations';
import type { Annotation } from '../services/api/annotations';
import { annotationAuthorKind, annotationStatus } from '@nuggets/shared';

interface RecordNotifyBannerProps {
  subjectType: string;
  subjectUuid: string;
}

type CalloutColor = React.ComponentProps<typeof Callout.Root>['color'];

const SEVERITY_COLOR: Record<string, CalloutColor> = {
  action_required: 'red',
  warning: 'amber',
  question: 'amber',
  info: 'blue',
};

/**
 * Surfaces open annotations flagged `notify` (e.g. an agent question) as a
 * banner at the top of a record's page. Shares the React
 * Query cache with <RecordActivity>, so no extra fetch.
 */
export const RecordNotifyBanner: React.FC<RecordNotifyBannerProps> = ({ subjectType, subjectUuid }) => {
  const { data } = useAnnotationsQuery(subjectType, subjectUuid);
  const updateMutation = useUpdateAnnotationMutation();

  const banners = (data?.annotations ?? []).filter(
    (a: Annotation) => !a.parent_uuid && a.notify && a.status === annotationStatus.enum.open,
  );
  if (banners.length === 0) return null;

  const setStatus = (uuid: string, status: 'acknowledged' | 'dismissed') =>
    updateMutation.mutate({ uuid, updates: { status, notify: false } });

  return (
    <Flex direction="column" gap="2">
      {banners.map((a) => (
        <Callout.Root highContrast key={a.uuid} color={SEVERITY_COLOR[a.severity ?? 'question'] ?? 'amber'}>
          <Callout.Icon>
            {a.author_kind === annotationAuthorKind.enum.agent ? <Bot size={16} /> : <TriangleAlert size={16} />}
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="2">
              <Box>
                <Text weight="medium">{a.author_kind === annotationAuthorKind.enum.agent ? (a.agent_name || 'Agent') : 'Note'}: </Text>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{a.body}</Text>
              </Box>
              <Flex gap="2">
                <Button
                  type="button"
                  size="1"
                  variant="soft"
                  onClick={() => setStatus(a.uuid, 'acknowledged')}
                  disabled={updateMutation.isPending}
                >
                  Acknowledge
                </Button>
                <Button
                  type="button"
                  size="1"
                  variant="soft"
                  color="gray"
                  onClick={() => setStatus(a.uuid, 'dismissed')}
                  disabled={updateMutation.isPending}
                >
                  Dismiss
                </Button>
              </Flex>
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ))}
    </Flex>
  );
};

export default RecordNotifyBanner;
