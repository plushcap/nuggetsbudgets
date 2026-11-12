import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPushDeviceCount, sendTestPush } from '../../services/api';

export const pushKeys = {
  all: ['push'] as const,
  deviceCount: () => ['push', 'device-count'] as const,
};

/** How many of the signed-in person's devices get push notifications. */
export function usePushDeviceCountQuery() {
  return useQuery({ queryKey: pushKeys.deviceCount(), queryFn: getPushDeviceCount });
}

export function useSendTestPushMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: sendTestPush,
    // A test can prune devices the push service reports as gone.
    onSuccess: () => void qc.invalidateQueries({ queryKey: pushKeys.all }),
  });
}
