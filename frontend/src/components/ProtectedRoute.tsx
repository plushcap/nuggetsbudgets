import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Flex } from '@radix-ui/themes';
import PageLoader from './PageLoader';
import LoadError from './LoadError';
import ChangePasswordRequiredPage from '../pages/ChangePasswordRequiredPage';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { user, loading, sessionError, retrySession, retryingSession, mayReturnAfterSignIn } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Flex align="center" justify="center" className="bg-[var(--color-background)]" minHeight="100vh">
        <PageLoader label="Loading…" size={48} />
      </Flex>
    );
  }

  // The server didn't answer who is signed in: that isn't "signed out".
  if (!user && sessionError) {
    return (
      <LoadError
        fullScreen
        title="Can't reach Nuggets"
        message="The server didn't answer. It may be restarting after an update; try again in a moment."
        error={sessionError}
        onRetry={retrySession}
        retrying={retryingSession}
      />
    );
  }

  if (!user) {
    // Sign-in returns here, unless someone just signed out: the next person to sign
    // in shouldn't land on the page the last one was on.
    return <Navigate to="/login" state={mayReturnAfterSignIn() ? { from: location } : undefined} replace />;
  }

  // An admin set this user's password: nothing else until they choose their own.
  if (user.must_change_password) {
    return <ChangePasswordRequiredPage />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
