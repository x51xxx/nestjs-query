import { BadRequestException } from '@nestjs/common'
import { getColumns, is, Table } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'

import type { SchemaEntry } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

export interface PrimaryKeyMeta {
  /** The JS property name of the primary key (rows are keyed by this, not by the DB column name). */
  field: string
  column: PgColumn
}

/**
 * Resolves a DTO field name to the column object a condition should be built against.
 *
 * Inside Drizzle's relational query builder the tables are aliased (`d0`, `d1`, ...), and a condition built from
 * the original column renders as `"table"."col"` -- invalid SQL in that context. Passing a resolver backed by the
 * aliased table reference handed to RQB's callbacks fixes that without duplicating the builders.
 */
export type ColumnResolver = (field: string) => PgColumn

/**
 * @internal
 * Own-property lookup for the name-keyed maps (columns, relations) that filter, sort and aggregate keys index into.
 * A plain `map[key]` also finds `constructor`, `toString` or `__proto__` on `Object.prototype`, which would let such a
 * key past the "unknown field" guard and into the SQL builders.
 */
export const hasOwn = (record: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(record, key) as boolean

/**
 * @internal
 * Runtime metadata for a single Drizzle table.
 *
 * Drizzle tables are plain objects with no decorator metadata, so everything the adapter needs (column lookup by
 * DTO field name, the primary key) is derived here from `getColumns()`, which is keyed by JS property name -- the
 * same keys Drizzle uses for the row objects it returns.
 */
export class TableMeta<Entity> {
  readonly table: PgTable

  readonly columns: Record<string, PgColumn>

  readonly primaryKeyColumns: readonly PgColumn[]

  readonly primaryKey: PrimaryKeyMeta

  private readonly columnFields: Map<PgColumn, string>

  constructor(
    table: SchemaEntry,
    readonly tableName: string
  ) {
    if (!is(table, Table)) {
      throw new Error(`"${tableName}" is not a Drizzle table. @ptc-org/nestjs-query-drizzle does not support views.`)
    }

    this.table = table as PgTable
    this.columns = getColumns(table) as Record<string, PgColumn>
    this.columnFields = new Map(Object.entries(this.columns).map(([field, column]) => [column, field]))
    const primaryKeys = this.resolvePrimaryKeys()
    this.primaryKeyColumns = primaryKeys.map(({ column }) => column)
    this.primaryKey = this.resolvePrimaryKey(primaryKeys)
  }

  /**
   * Resolves a DTO field name to its Drizzle column, throwing when the field has no matching column. Failing loudly
   * matters because Drizzle's operators accept `undefined` and would otherwise emit nonsense SQL.
   */
  public column(field: keyof Entity | string): PgColumn {
    const column = hasOwn(this.columns, field as string) ? this.columns[field as string] : undefined

    if (!column) {
      throw new BadRequestException(
        `Unknown field "${String(field)}" on table "${this.tableName}". Available fields: ${Object.keys(this.columns).join(', ')}`
      )
    }

    return column
  }

  /**
   * Builds a {@link ColumnResolver}. When `aliased` is supplied (the table reference Drizzle hands to an RQB
   * callback) the field is still validated against this table, so the unknown-field guard and its error message
   * stay in one place, but the returned column is the aliased one.
   */
  public resolver(aliased?: Record<string, PgColumn>): ColumnResolver {
    return (field: string): PgColumn => {
      const column = this.column(field)

      if (!aliased) {
        return column
      }

      const aliasedColumn = aliased[field]
      if (!aliasedColumn) {
        throw new Error(`Aliased table "${this.tableName}" does not expose column field "${field}"`)
      }

      return aliasedColumn
    }
  }

  /**
   * Reverse lookup: the JS property name a column is exposed under. Needed to read a join key's value off a row,
   * since rows are keyed by property name rather than by DB column name.
   */
  public fieldFor(column: PgColumn): string {
    const field = this.columnFields.get(column)

    if (!field) {
      throw new Error(`Column "${column.name}" does not belong to table "${this.tableName}"`)
    }

    return field
  }

  public isPrimaryKeyColumn(column: PgColumn): boolean {
    return this.primaryKeyColumns.includes(column)
  }

  /**
   * `QueryService.findById` takes a scalar id, so only single-column primary keys are representable. Resolving this
   * eagerly means a misconfigured table fails at module bootstrap rather than on the first mutation.
   */
  private resolvePrimaryKeys(): PrimaryKeyMeta[] {
    const inlineColumns = Object.values(this.columns).filter((column) => column.primary)
    // Table-level constraints store extra-config column instances rather than the objects returned by getColumns().
    // Normalize them back to the row-shape columns so identity-based relation metadata continues to work.
    const tableLevelColumns = getTableConfig(this.table).primaryKeys.flatMap(({ columns }) =>
      columns.map((column) => Object.values(this.columns).find((candidate) => candidate.name === column.name) ?? column)
    )
    const primaryKeyColumns = [...new Set([...inlineColumns, ...tableLevelColumns])]

    return primaryKeyColumns.map((column) => ({ field: this.fieldFor(column), column }))
  }

  private resolvePrimaryKey(primaryKeys: PrimaryKeyMeta[]): PrimaryKeyMeta {
    if (primaryKeys.length === 1) {
      return primaryKeys[0]
    }

    if (!primaryKeys.length) {
      throw new Error(
        `Table "${this.tableName}" has no primary key. @ptc-org/nestjs-query-drizzle requires a single-column primary key.`
      )
    }

    throw new Error(
      `Table "${this.tableName}" has a composite primary key (${primaryKeys
        .map(({ field }) => field)
        .join(', ')}). @ptc-org/nestjs-query-drizzle requires a single-column primary key.`
    )
  }
}
