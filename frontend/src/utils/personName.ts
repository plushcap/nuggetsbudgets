/**
 * A person's name as the pages show it. `users.first_name` and `last_name` are nullable, and
 * the API answers them as they are, so a name is the parts that are set, and
 * initials the first letter of each part that is.
 */
export interface NamedPerson {
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
}

const parts = (person: NamedPerson): string[] =>
  [person.first_name, person.last_name].map((part) => part?.trim() ?? '').filter((part) => part !== '');

/** "Ada Lovelace", "Ada", or `fallback` when neither name is set. */
export const personName = (person: NamedPerson, fallback = 'Unnamed'): string => parts(person).join(' ') || fallback;

/** "AL", "A", or `fallback` when neither name is set. */
export const personInitials = (person: NamedPerson, fallback = '?'): string =>
  parts(person).map((part) => part.charAt(0)).join('') || fallback;
