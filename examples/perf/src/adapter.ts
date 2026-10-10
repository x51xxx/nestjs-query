import { INestApplication, ModuleMetadata } from '@nestjs/common'

/** Exactly what Nest accepts in a module's `imports`, so adapters stay type-checked. */
export type NestImport = NonNullable<ModuleMetadata['imports']>[number]

export interface SeedSizes {
  todoItems: number
  subTasksPerItem: number
  tags: number
  tagsPerItem: number
}

/**
 * The default is deliberately large. At a few thousand rows every dataset sits in the page cache and the numbers
 * measure per-request overhead rather than data access -- and the adapter ranking at that size is not the ranking
 * at scale (see the 5k vs 200k tables in README.md). Seeding cost is a few seconds even here.
 */
export const DEFAULT_SIZES: SeedSizes = {
  todoItems: 100_000,
  subTasksPerItem: 3,
  tags: 50,
  tagsPerItem: 3
}

/**
 * One persistence backend for the benchmark.
 *
 * Every adapter serves the same GraphQL schema (see `src/dto`), so a single set of k6 scenarios runs unchanged
 * against all of them. Seeding is each adapter's own business but must bypass the nestjs-query service layer --
 * routing it through `createMany` would fold the code path under test into setup time.
 */
export interface PerfAdapter {
  readonly name: string
  readonly backend: 'postgres' | 'mongo'
  /** Modules that establish the connection and register the feature modules. */
  imports(): NestImport[]
  /** Drops any existing data, recreates the schema/indexes and inserts `sizes` worth of rows. */
  seed(app: INestApplication, sizes: SeedSizes): Promise<void>
}
