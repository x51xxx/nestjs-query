import { drizzle } from 'drizzle-orm/pg-proxy'

import type { TablesRelationalConfig } from 'drizzle-orm'

import { DrizzleDatabase } from '../../src'
import { testRelations } from './relations.fixture'

export interface CapturedQuery {
  sql: string
  params: unknown[]
  method: string
}

export interface StubDb {
  db: DrizzleDatabase
  captured: CapturedQuery[]
  /**
   * Queues the rows the next query (or queries) should resolve with.
   *
   * IMPORTANT: each row is a **positional array**, not an object -- that is the wire format Drizzle's proxy driver
   * expects, and it maps values onto the selected columns by position.
   */
  queueRows(...rowSets: unknown[][][]): void
  queueError(error: Error): void
  lastQuery(): CapturedQuery
  reset(): void
}

/**
 * Builds a real Drizzle `db` whose executor is stubbed, so tests exercise genuine SQL generation and row mapping
 * without any database. Used instead of a real Postgres because unit tests must not depend on persistent storage.
 */
export const createStubDb = (relations: TablesRelationalConfig = testRelations): StubDb => {
  const captured: CapturedQuery[] = []
  const responses: (Error | unknown[][])[] = []

  const db = drizzle(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (sql: string, params: unknown[], method: string) => {
      captured.push({ sql, params, method })
      const response = responses.shift() ?? []
      if (response instanceof Error) {
        throw response
      }

      return { rows: response }
    },
    { relations }
  ) as unknown as DrizzleDatabase

  return {
    db,
    captured,
    queueRows(...rowSets: unknown[][][]): void {
      responses.push(...rowSets)
    },
    queueError(error: Error): void {
      responses.push(error)
    },
    lastQuery(): CapturedQuery {
      return captured[captured.length - 1]
    },
    reset(): void {
      captured.length = 0
      responses.length = 0
    }
  }
}
