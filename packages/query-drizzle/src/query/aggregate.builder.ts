import { BadRequestException } from '@nestjs/common'
import {
  AggregateQuery,
  AggregateQueryField,
  AggregateQueryGroupByField,
  AggregateResponse,
  GroupBy
} from '@ptc-org/nestjs-query-core'
import { avg, count, max, min, SQL, sql, sum } from 'drizzle-orm'

import type { PgColumn } from 'drizzle-orm/pg-core'

import { TableMeta } from './table.utils'

type AggregateFunc = 'count' | 'sum' | 'avg' | 'max' | 'min'
type AggregateSelectionKind = AggregateFunc | 'groupBy'

/** Functions whose Postgres result must be coerced -- `sum`/`avg` come back as strings for numeric columns. */
const NUMERIC_FUNCS = new Set<AggregateSelectionKind>(['count', 'sum', 'avg'])

interface AggregateEntry<Entity> {
  alias: string
  kind: AggregateSelectionKind
  field: keyof Entity
}

export interface BuiltAggregate<Entity> {
  selection: Record<string, SQL | PgColumn>
  groupBy: (SQL | PgColumn)[]
  /** Declared as a bound function property, not a method, so destructuring it stays safe. */
  convert: (rows: Record<string, unknown>[]) => AggregateResponse<Entity>[]
  /** The result SQL aggregation returns for an empty, ungrouped input. Grouped input has no result rows. */
  empty: () => AggregateResponse<Entity>[]
}

const DATE_TRUNC_UNITS: Partial<Record<GroupBy, string>> = {
  [GroupBy.DAY]: 'day',
  [GroupBy.WEEK]: 'week',
  [GroupBy.MONTH]: 'month',
  [GroupBy.YEAR]: 'year'
}

const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

/**
 * @internal
 * Builds the SELECT map for an `AggregateQuery` and converts the resulting rows into an `AggregateResponse`.
 *
 * Drizzle keys result rows by the selection object's keys, so this generates opaque aliases and keeps an explicit
 * alias -> (function, field) table. That avoids parsing aliases back out of the result (which breaks for DTO field
 * names containing the separator character).
 */
export class AggregateBuilder<Entity> {
  constructor(private readonly tableMeta: TableMeta<Entity>) {}

  public build(aggregate: AggregateQuery<Entity>): BuiltAggregate<Entity> {
    const selection: Record<string, SQL | PgColumn> = {}
    const groupBy: (SQL | PgColumn)[] = []
    const entries: AggregateEntry<Entity>[] = []

    let aliasIndex = 0
    const nextAlias = (): string => `agg_${aliasIndex++}`

    for (const groupByField of aggregate.groupBy ?? []) {
      const alias = nextAlias()
      const expression = this.groupByExpression(groupByField)

      selection[alias] = expression
      groupBy.push(expression)
      entries.push({ alias, kind: 'groupBy', field: groupByField.field })
    }

    const funcs: [AggregateFunc, AggregateQueryField<Entity>[] | undefined][] = [
      ['count', aggregate.count],
      ['sum', aggregate.sum],
      ['avg', aggregate.avg],
      ['max', aggregate.max],
      ['min', aggregate.min]
    ]

    for (const [func, fields] of funcs) {
      for (const { field } of fields ?? []) {
        const alias = nextAlias()

        selection[alias] = this.aggregateExpression(func, this.tableMeta.column(field))
        entries.push({ alias, kind: func, field })
      }
    }

    if (!entries.length) {
      throw new BadRequestException('No aggregate fields found.')
    }

    return {
      selection,
      groupBy,
      convert: (rows) => this.convert(rows, entries),
      empty: () => this.empty(entries)
    }
  }

  private aggregateExpression(func: AggregateFunc, column: PgColumn): SQL {
    switch (func) {
      case 'count':
        return count(column) as unknown as SQL
      case 'sum':
        return sum(column) as unknown as SQL
      case 'avg':
        return avg(column) as unknown as SQL
      case 'max':
        return max(column) as unknown as SQL
      default:
        return min(column) as unknown as SQL
    }
  }

  /**
   * Date bucketing for `groupBy`, with the same buckets as the Postgres branch of the TypeORM adapter's
   * `AggregateBuilder` (ISO, Monday-based weeks).
   *
   * The bucket is cast back to the column's own SQL type and mapped with the column, so it comes back exactly like
   * the column itself would. A bare `DATE(...)` returns a Postgres `date`, which Drizzle's node-postgres driver leaves
   * as a string -- and GraphQL's `DateTime` serializes a string to `null`, so every bucketed group would be `null`.
   */
  private groupByExpression(groupByField: AggregateQueryGroupByField<Entity>): SQL | PgColumn {
    const column = this.tableMeta.column(groupByField.field)
    const unit = DATE_TRUNC_UNITS[groupByField.args?.by]

    if (!unit) {
      return column
    }

    // `getSQLType()` comes from the schema definition, never from the query, so inlining it is safe.
    return sql`CAST(DATE_TRUNC(${sql.raw(`'${unit}'`)}, ${column}) AS ${sql.raw(column.getSQLType())})`.mapWith(column)
  }

  private convert(rows: Record<string, unknown>[], entries: AggregateEntry<Entity>[]): AggregateResponse<Entity>[] {
    return rows.map((row) =>
      entries.reduce((response: AggregateResponse<Entity>, { alias, kind, field }) => {
        const raw = row[alias]

        if (kind === 'groupBy') {
          return { ...response, groupBy: { ...response.groupBy, [field]: raw } }
        }

        const value = NUMERIC_FUNCS.has(kind) ? toNumber(raw) : raw

        return { ...response, [kind]: { ...response[kind], [field]: value } }
      }, {})
    )
  }

  private empty(entries: AggregateEntry<Entity>[]): AggregateResponse<Entity>[] {
    if (entries.some(({ kind }) => kind === 'groupBy')) {
      return []
    }

    const row = Object.fromEntries(entries.map(({ alias, kind }) => [alias, kind === 'count' ? 0 : null]))

    return this.convert([row], entries)
  }
}
