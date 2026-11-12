import React from 'react';
import LoadError from './LoadError';

/**
 * Sign-in's and first-run setup's screen when the server didn't say whether setup has
 * run. Sending a family to "Set up your admin account" because a restart was slow would
 * read as their data being gone.
 */
export const SetupStatusError: React.FC<{ error: unknown; onRetry: () => void; retrying: boolean }> = ({
  error,
  onRetry,
  retrying,
}) => (
  <LoadError
    fullScreen
    title="Can't reach Nuggets"
    message="The server didn't answer. It may be restarting after an update; try again in a moment."
    error={error}
    onRetry={onRetry}
    retrying={retrying}
  />
);
