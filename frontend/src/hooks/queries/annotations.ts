import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getAnnotations,
  createAnnotation,
  updateAnnotation,
  getAnnotationThreads,
  getAnnotationCounts,
  manuallyResolveAnnotations,
  type CreateAnnotationInput,
  type UpdateAnnotationInput,
} from '../../services/api/annotations';
import { annotationKeys } from './keys';

export function useAnnotationThreadsQuery(params: { status?: string; notify?: boolean; limit?: number }) {
  return useQuery({
    queryKey: annotationKeys.threads(params),
    queryFn: () => getAnnotationThreads(params),
  });
}

export function useAnnotationCountsQuery() {
  return useQuery({
    queryKey: annotationKeys.counts(),
    queryFn: () => getAnnotationCounts(),
  });
}

export function useAnnotationsQuery(subjectType: string, subjectUuid: string | undefined, enabled = true) {
  return useQuery({
    queryKey: annotationKeys.bySubject(subjectType, subjectUuid ?? ''),
    queryFn: () => getAnnotations(subjectType, subjectUuid as string),
    enabled: enabled && !!subjectUuid,
  });
}

export function useCreateAnnotationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAnnotationInput) => createAnnotation(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: annotationKeys.all });
    },
  });
}

export function useUpdateAnnotationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, updates }: { uuid: string; updates: UpdateAnnotationInput }) =>
      updateAnnotation(uuid, updates),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: annotationKeys.all });
    },
  });
}

/**
 * Manually resolve one thread ({ uuid }) or a bulk scope ({ scope }).
 * Invalidates all annotation queries so the list and the nav badge refresh.
 */
export function useManuallyResolveAnnotationsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { uuid: string } | { scope: 'all' | 'reviewed' }) =>
      manuallyResolveAnnotations(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: annotationKeys.all });
    },
  });
}
