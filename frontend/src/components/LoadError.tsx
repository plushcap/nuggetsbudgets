import React from 'react';
import { Button, Flex, Heading, Text } from '@radix-ui/themes';
import { CloudOff } from 'lucide-react';
import { errorRequestId } from '../utils/errors';
import PageContainer from './PageContainer';

interface LoadErrorProps {
  /** The page's heading (an h1: this replaces the page). */
  title: string;
  /** What failed and what the person can do, in their words. */
  message: string;
  /** The caught error: a server error's request id is shown, so a report can quote it. */
  error?: unknown;
  onRetry: () => void;
  /** A retry is running: the button says so and waits. */
  retrying?: boolean;
  /** Centred on the whole screen (no app shell around it: sign-in, first-run setup). */
  fullScreen?: boolean;
}

/**
 * What a page shows when the data it needs didn't load: the server couldn't be
 * reached or failed. Never "not found", "signed out" or "first run", which would be
 * wrong and, for a household's money, alarming; a retry is one click away.
 */
const LoadError: React.FC<LoadErrorProps> = ({ title, message, error, onRetry, retrying = false, fullScreen = false }) => {
  const requestId = errorRequestId(error);
  const body = (
    <PageContainer width="auth">
      <Flex direction="column" align="center" gap="4" py="9" role="alert">
        <CloudOff aria-hidden size={48} className="text-[var(--gray-11)]" />
        <Heading as="h1" size="5" align="center">
          {title}
        </Heading>
        <Text color="gray" align="center">
          {message}
        </Text>
        {requestId && (
          <Text size="1" color="gray" align="center">
            Reference {requestId}
          </Text>
        )}
        <Button onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      </Flex>
    </PageContainer>
  );
  if (!fullScreen) return body;
  return (
    <Flex align="center" justify="center" className="bg-[var(--color-background)]" minHeight="100vh">
      {body}
    </Flex>
  );
};

export default LoadError;
