/**
 * `values` without the properties whose value is undefined, typed to match: what a request
 * left out (a query parameter, an optional field) becomes an absent option rather than an
 * undefined one, which an optional property doesn't take under exactOptionalPropertyTypes.
 * A property whose type can't be undefined stays required.
 */
export function withoutUndefined<T extends object>(values: T): WithoutUndefined<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as WithoutUndefined<T>;
}

export type WithoutUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
