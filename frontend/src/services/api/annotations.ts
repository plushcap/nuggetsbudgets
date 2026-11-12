import {
  annotationCountsResponseSchema,
  annotationCreatedResponseSchema,
  annotationManualResolveResponseSchema,
  annotationThreadsQuery,
  annotationThreadsResponseSchema,
  annotationTimelineQuery,
  annotationTimelineResponseSchema,
  annotationUpdatedResponseSchema,
  queryString,
  type AnnotationCounts as SharedAnnotationCounts,
  type AnnotationCreated,
  type AnnotationResponse,
  type AnnotationThread as SharedAnnotationThread,
  type AnnotationTimelineResponse,
  type AnnotationUpdated,
  type annotationCreateSchema,
  type annotationManualResolveSchema,
  type annotationUpdateSchema,
} from '@nuggets/shared';
import { apiGet, apiPost, apiPatch } from './base';
import { parseAnswer } from './parseAnswer';
import type { RequestBody } from './types';

/**
 * Annotations — the agent⇄human reasoning & discussion log on records.
 * The UI surfaces these as "Activity". Phase 1: transactions. The answers are
 * `@nuggets/shared`'s annotation schemas, parsed.
 */

/** One entry of a record's timeline: annotationResponseSchema. */
export type Annotation = AnnotationResponse;

/** GET /annotations: annotationTimelineResponseSchema. */
export type AnnotationListResponse = AnnotationTimelineResponse;

/** POST /annotations body (annotationCreateSchema): a root (subject_type + subject_uuid) or a reply (parent_uuid). */
export type CreateAnnotationInput = RequestBody<typeof annotationCreateSchema>;

/** PATCH /annotations/:uuid body (annotationUpdateSchema): a severity, feedback or reason of none is null. */
export type UpdateAnnotationInput = RequestBody<typeof annotationUpdateSchema>;

export const getAnnotations = async (subjectType: string, subjectUuid: string): Promise<AnnotationListResponse> =>
  parseAnswer(
    annotationTimelineResponseSchema,
    await apiGet<unknown>(`/annotations${queryString(annotationTimelineQuery, { subject_type: subjectType, subject_uuid: subjectUuid })}`),
    'annotations',
  );

export const createAnnotation = async (input: CreateAnnotationInput): Promise<AnnotationCreated> =>
  parseAnswer(annotationCreatedResponseSchema, await apiPost<unknown>('/annotations', input), 'annotation');

export const updateAnnotation = async (uuid: string, updates: UpdateAnnotationInput): Promise<AnnotationUpdated> =>
  parseAnswer(annotationUpdatedResponseSchema, await apiPatch<unknown>(`/annotations/${uuid}`, updates), 'annotation');

/** One thread of the Activity page: annotationThreadResponseSchema. */
export type AnnotationThread = SharedAnnotationThread;

/** GET /annotations/counts: annotationCountsResponseSchema. */
export type AnnotationCounts = SharedAnnotationCounts;

/** GET /annotations/threads; a notify of false is left out, which reads as false. */
export const getAnnotationThreads = async (params: {
  status?: string | undefined;
  notify?: boolean | undefined;
  limit?: number | undefined;
}): Promise<{ threads: AnnotationThread[] }> =>
  parseAnswer(
    annotationThreadsResponseSchema,
    await apiGet<unknown>(
      `/annotations/threads${queryString(annotationThreadsQuery, {
        status: params.status,
        notify: params.notify || undefined,
        limit: params.limit || undefined,
      })}`,
    ),
    'annotation threads',
  );

export const getAnnotationCounts = async (): Promise<AnnotationCounts> =>
  parseAnswer(annotationCountsResponseSchema, await apiGet<unknown>('/annotations/counts'), 'annotation counts');

/**
 * Manually resolve open activity thread(s): posts an `answer` reply recording
 * the resolution, which moves the thread to `answered`.
 *
 * Pass `uuid` for one thread, or a bulk `scope`:
 *   - 'all'      — every open thread
 *   - 'reviewed' — open threads whose transaction is already reviewed
 */
export const manuallyResolveAnnotations = async (
  input: RequestBody<typeof annotationManualResolveSchema>,
): Promise<{ resolved: number }> =>
  parseAnswer(annotationManualResolveResponseSchema, await apiPost<unknown>('/annotations/manual-resolve', input), 'manual resolve');
