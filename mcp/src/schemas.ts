import { z } from 'zod';

/**
 * A boolean that also takes "true"/"false", as models sometimes send one. Not
 * z.coerce.boolean(), which reads any non-empty string, "false" included, as true.
 */
export const booleanInput = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');
