import * as drizzleOrm from 'drizzle-orm'

const drizzleEmptyFilter = (drizzleOrm as unknown as { EmptyFilter?: symbol }).EmptyFilter

/** @internal */
export const isEmptyRelationsFilter = (filter: unknown): boolean =>
  filter === undefined || (drizzleEmptyFilter !== undefined && filter === drizzleEmptyFilter)

/**
 * Drizzle rc.5 requires the `EmptyFilter` sentinel where rc.4 accepts `undefined` -- rc.5 throws
 * `Unexpected 'undefined' in filter value` instead of skipping the field. Returning the export only when the
 * installed Drizzle version provides it keeps both APIs working without importing a symbol that does not exist in
 * rc.4's type declarations.
 *
 * @internal
 */
export const toDrizzleRelationsFilter = <T>(filter: T | undefined): T | symbol | undefined => filter ?? drizzleEmptyFilter

/**
 * Whether a relation's predefined `where` is scoped to the *source* table rather than the target one.
 *
 * Drizzle sets this when a relation declares neither `from` nor `to` and its join keys are inferred from the
 * reverse relation: the inherited `where` then still refers to the reverse relation's own table. rc.5 renamed the
 * flag from `isReversed` to `isFilterReversed`, so both spellings are read.
 *
 * @internal
 */
export const isRelationFilterReversed = (relation: unknown): boolean => {
  const flags = relation as { isFilterReversed?: boolean; isReversed?: boolean }

  return flags.isFilterReversed ?? flags.isReversed ?? false
}
