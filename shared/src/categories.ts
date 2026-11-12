import { z } from 'zod';
import { instant } from './responses.js';

/**
 * POST /api/categories and PUT /api/categories/:uuid body: name (trimmed, 1 to 100
 * characters) and icon are required; description, priority and notes are optional text.
 * Other fields pass through (looseObject). A field the columns can't hold (a priority or
 * an icon longer than its column, a description that isn't text) is a 400 here, where it
 * was a 500 from the database or from `.trim()` on a non-string.
 */
export const categoryWriteSchema = z.looseObject({
  name: z
    .string({ error: 'Name and icon are required' })
    .trim()
    .min(1, 'Name and icon are required')
    .max(100, 'Category name must be 100 characters or less'),
  icon: z
    .string({ error: 'Name and icon are required' })
    .min(1, 'Name and icon are required')
    .max(100, 'Category icon must be 100 characters or less'),
  description: z.string({ error: 'description must be text' }).nullish(),
  priority: z.string({ error: 'priority must be text' }).max(50, 'Category priority must be 50 characters or less').nullish(),
  notes: z.string({ error: 'notes must be text' }).nullish(),
});
export type CategoryWriteInput = z.infer<typeof categoryWriteSchema>;

/** POST /api/categories body ({@link categoryWriteSchema}). */
export const categoryCreateSchema = categoryWriteSchema;
export type CategoryCreateInput = CategoryWriteInput;

/** PUT /api/categories/:uuid body ({@link categoryWriteSchema}): the whole category, as on create. */
export const categoryUpdateSchema = categoryWriteSchema;
export type CategoryUpdateInput = CategoryWriteInput;

/**
 * A category as the API answers it: GET /api/categories lists them, and a
 * create or an update answers the one written. priority is free text ('Undefined' when none
 * was chosen); icon may be null on an older row.
 */
export const categoryResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  priority: z.string().nullable(),
  notes: z.string().nullable(),
  icon: z.string().nullable(),
  created_at: instant,
});
export type CategoryResponse = z.infer<typeof categoryResponseSchema>;

/** GET /api/categories. */
export const categoryListResponseSchema = z.array(categoryResponseSchema);
