import { Class } from '@ptc-org/nestjs-query-core'

import type { AnyRelations } from 'drizzle-orm'
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

/**
 * The `db` instance built by any Postgres driver's `drizzle(...)` factory (node-postgres, postgres-js, neon,
 * pglite, ...). All of them extend `PgAsyncDatabase`, which is what this adapter is written against.
 */
export type DrizzleDatabase<TRelations extends AnyRelations = AnyRelations> = PgAsyncDatabase<PgQueryResultHKT, TRelations>

export type DrizzleRelationForeignKeySide = 'source' | 'target'

export interface NestjsQueryDrizzleRelationOptions {
  /**
   * Explicitly identifies the table that stores this relation's foreign key. Usually inferred from foreign keys
   * declared in the Drizzle schema via `.references()`; needed when those declarations are absent or ambiguous.
   */
  foreignKeySide?: DrizzleRelationForeignKeySide
}

/**
 * Maps a GraphQL-facing DTO class to the table it is persisted as. Drizzle tables are plain objects (no class
 * identity like a TypeORM `@Entity()`), so unlike `query-typeorm`, the DTO <-> table association can't be
 * inferred from the table itself and must be declared explicitly here.
 *
 * `tableName` is the key of this table within the `TablesRelationalConfig` returned by `defineRelations()` -- it
 * is used both to look up the table itself and to resolve this DTO's relations.
 */
export interface NestjsQueryDrizzleModelDefinition<Entity> {
  DTOClass: Class<Entity>
  tableName: string
  relationOptions?: Record<string, NestjsQueryDrizzleRelationOptions>
}
