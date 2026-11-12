import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Transaction } from '../services/api/types';

/**
 * Shared "quick edit" navigation for transaction lists.
 *
 * Opens the transaction detail page in edit mode and records the current
 * location as `returnTo` so the detail page can navigate back to where the
 * user came from (preserving pagination/filter state in the URL).
 *
 * Used by any page that renders a transaction table (Tasks, tag detail, …)
 * so the quick-edit behaviour stays consistent across the app.
 */
export const useOpenTransactionEdit = (): ((transaction: Transaction) => void) => {
  const navigate = useNavigate();

  return useCallback(
    (transaction: Transaction) => {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      navigate(`/transactions/${transaction.uuid}?edit=true&returnTo=${returnTo}`);
    },
    [navigate]
  );
};

export default useOpenTransactionEdit;
