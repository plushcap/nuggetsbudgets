/**
 * One shared empty array to default a query's data to: `const { data: tags = EMPTY_LIST }`.
 *
 * A literal `= []` default is a new array on every render while the query has no data
 * yet (loading, disabled or failed). An effect that depends on it and sets state then
 * runs on every render and loops until React gives up (React error #185, "Maximum update
 * depth exceeded"). This one never changes identity. It is frozen, so code that tries
 * to push into it fails loudly instead of changing it for everyone.
 */
export const EMPTY_LIST = Object.freeze([]) as unknown as never[];
