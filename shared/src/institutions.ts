import { z } from 'zod';
import { instant, responseCount } from './responses.js';

/**
 * POST /api/institutions and PUT /api/institutions/:uuid body: the name is required
 * (trimmed, up to the column's 255 characters); notes are optional text. Other fields pass
 * through (looseObject).
 */
export const institutionWriteSchema = z.looseObject({
  name: z
    .string({ error: 'Institution name is required' })
    .trim()
    .min(1, 'Institution name is required')
    .max(255, 'Institution name must be 255 characters or less'),
  notes: z.string({ error: 'notes must be text' }).nullish(),
});
export type InstitutionWriteInput = z.infer<typeof institutionWriteSchema>;

/** POST /api/institutions body ({@link institutionWriteSchema}). */
export const institutionCreateSchema = institutionWriteSchema;
export type InstitutionCreateInput = InstitutionWriteInput;

/** PUT /api/institutions/:uuid body ({@link institutionWriteSchema}): the whole institution, as on create. */
export const institutionUpdateSchema = institutionWriteSchema;
export type InstitutionUpdateInput = InstitutionWriteInput;

/** An institution's own columns, as one institution, a create, an update and a delete answer them. */
export const institutionRowResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  notes: z.string().nullable(),
  created_at: instant,
});

/** An institution as the API answers it: with how many accounts are at it in the list (GET /api/institutions). */
export const institutionResponseSchema = institutionRowResponseSchema.extend({
  account_count: responseCount.optional(),
});
export type InstitutionResponse = z.infer<typeof institutionResponseSchema>;

/** GET /api/institutions: every institution by name, each with its account count. */
export const institutionListResponseSchema = z.array(institutionResponseSchema.required({ account_count: true }));

/** DELETE /api/institutions/:uuid: the institution deleted. */
export const institutionDeletedResponseSchema = z.object({
  success: z.literal(true),
  deleted: institutionRowResponseSchema,
  message: z.string(),
});
export type InstitutionDeletedResponse = z.infer<typeof institutionDeletedResponseSchema>;
