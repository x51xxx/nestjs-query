import { Filter, Query, SortDirection, SortField, SortNulls } from '@ptc-org/nestjs-query-core'
import { asc, desc, SQL, sql } from 'drizzle-orm'

import type { PgColumn } from 'drizzle-orm/pg-core'

import { ColumnResolver, TableMeta } from './table.utils'
import { RelationResolver, WhereBuilder } from './where.builder'

/**
 * @internal
 * The subset of a Drizzle `$dynamic()` builder this package uses.
 *
 * Drizzle's concrete builder types carry a large generic payload that changes shape with every chained clause;
 * reproducing it here buys nothing, since `$dynamic()` exists precisely so clauses can be added conditionally.
 */
interface DynamicQueryBuilder {
  where(condition: SQL | undefined): DynamicQueryBuilder
  orderBy(...columns: (SQL | PgColumn)[]): DynamicQueryBuilder
  groupBy(...columns: (SQL | PgColumn)[]): DynamicQueryBuilder
  limit(limit: number): DynamicQueryBuilder
  offset(offset: number): DynamicQueryBuilder
}

/**
 * @internal
 * Composes a `Query` onto a Drizzle `$dynamic()` query builder.
 */
export class FilterQueryBuilder<Entity> {
  constructor(
    readonly tableMeta: TableMeta<Entity>,
    /**
     * Supplied only where the queried table's own relations are addressable, i.e. the root query path. Relation
     * filters reach a table through its own service, never through another table's relation query.
     */
    resolveRelation?: RelationResolver,
    readonly whereBuilder: WhereBuilder<Entity> = new WhereBuilder<Entity>(tableMeta, undefined, resolveRelation)
  ) {}

  public whereClause(filter?: Filter<Entity>, resolveColumn?: ColumnResolver): SQL | undefined {
    if (!filter) {
      return undefined
    }

    return this.whereBuilder.build(filter, resolveColumn ?? this.tableMeta.resolver())
  }

  public orderByClause(sorting?: SortField<Entity>[], resolveColumn?: ColumnResolver): (SQL | PgColumn)[] {
    const resolve = resolveColumn ?? this.tableMeta.resolver()

    return (sorting ?? []).map((sort) => this.sortExpression(sort, resolve))
  }

  /**
   * Applies filter, sorting and paging to a dynamic query builder.
   */
  public applyQuery<Q>(qb: Q, query: Query<Entity>): Q {
    let dynamicQb = qb as DynamicQueryBuilder

    const where = this.whereClause(query.filter)
    if (where) {
      dynamicQb = dynamicQb.where(where)
    }

    const orderBy = this.orderByClause(query.sorting)
    if (orderBy.length) {
      dynamicQb = dynamicQb.orderBy(...orderBy)
    }

    if (query.paging?.limit !== undefined) {
      dynamicQb = dynamicQb.limit(query.paging.limit)
    }

    if (query.paging?.offset !== undefined) {
      dynamicQb = dynamicQb.offset(query.paging.offset)
    }

    return dynamicQb as Q
  }

  /**
   * Applies an aggregate's filter and GROUP BY to a dynamic query builder.
   */
  public applyAggregate<Q>(qb: Q, filter: Filter<Entity>, groupBy: (SQL | PgColumn)[]): Q {
    let dynamicQb = qb as DynamicQueryBuilder

    const where = this.whereClause(filter)
    if (where) {
      dynamicQb = dynamicQb.where(where)
    }

    if (groupBy.length) {
      dynamicQb = dynamicQb.groupBy(...groupBy)
    }

    return dynamicQb as Q
  }

  private sortExpression(sort: SortField<Entity>, resolveColumn: ColumnResolver): SQL | PgColumn {
    const column = resolveColumn(sort.field as string)
    const isDesc = sort.direction === SortDirection.DESC

    if (sort.nulls) {
      // `asc()`/`desc()` cannot express NULLS FIRST/LAST. Both fragments come from core enums, never user input.
      const direction = isDesc ? 'desc' : 'asc'
      const nulls = sort.nulls === SortNulls.NULLS_FIRST ? 'nulls first' : 'nulls last'

      return sql`${column} ${sql.raw(direction)} ${sql.raw(nulls)}`
    }

    return isDesc ? desc(column) : asc(column)
  }
}
