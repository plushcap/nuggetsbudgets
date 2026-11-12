import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Flex, Heading, Text, Button } from '@radix-ui/themes';
import { TriangleAlert } from 'lucide-react';
import { logger } from '../utils/logger';
import PageContainer from './PageContainer';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * When any value in this array changes, the boundary clears its error state
   * and re-renders its children. Pass the current route (e.g. the pathname) so
   * a transient error on one page doesn't persist after the user navigates.
   */
  resetKeys?: ReadonlyArray<unknown>;
  /** Optional custom fallback. Defaults to the recoverable error card below. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

const resetKeysChanged = (a: ReadonlyArray<unknown> = [], b: ReadonlyArray<unknown> = []): boolean =>
  a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));

/**
 * Catches render-time exceptions and lazy-chunk load failures anywhere below it
 * and shows a recoverable fallback instead of unmounting the whole tree to a
 * blank screen. The app previously had no error boundary at all.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error({ err: error, componentStack: info.componentStack }, 'Uncaught error in React tree');
  }

  override componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    return (
      <PageContainer width="form" py="9">
        <Flex direction="column" align="center" gap="4">
          <TriangleAlert size={64} className="text-[var(--amber-12)]" />
          <Heading as="h2" size="5" align="center">
            Something went wrong
          </Heading>
          <Text color="gray" align="center">
            This page failed to load. Reloading usually fixes it — this can happen briefly
            after an update.
          </Text>
          <Flex gap="3" wrap="wrap" justify="center">
            <Button onClick={() => window.location.reload()}>Reload page</Button>
            <Button variant="soft" color="gray" onClick={() => window.location.assign('/')}>
              Go to dashboard
            </Button>
          </Flex>
        </Flex>
      </PageContainer>
    );
  }
}

export default ErrorBoundary;
