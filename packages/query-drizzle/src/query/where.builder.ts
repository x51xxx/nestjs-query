import { Filter, FilterComparisons, FilterFieldComparison } from '@ptc-org/nestjs-query-core'
import { aliasedTable, and, eq, exists, getTableAsAliasSQL, or, SQL, sql } from 'drizzle-orm'

import type { PgColumn } from 'drizzle-orm/pg-core'

import { ComparisonBuilder, ComparisonField } from './comparison.builder'
import { RelationMeta } from './relation.utils'
import { ColumnResolver, TableMeta } from './table.utils'

const isDefined = (condition: SQL | undefined): condition is SQL => condition !== undefined

/**
 * Resolves a filter key to the relation it names, or `undefined` when the key is a plain column.
 *
 * @internal
 */
export type RelationResolver = (field: string) => RelationMeta<unknown, unknown> | undefined

/**
 * Aliases for the tables a relation filter's subquery selects from. Fixed rather than generated: sibling `EXISTS`
 * subqueries are separate scopes, and `query-graphql` only ever nests relation filters one level deep.
 */
const RELATION_ALIAS = '__nq_rel'
const THROUGH_ALIAS = '__nq_rel_through'

/**
 * @internal
 * Builds a Drizzle WHERE condition from a `Filter`.
 *
 * Composition rules mirror the other adapters (see `query-typeorm`'s `WhereBuilder`):
 * - the `and` group, the `or` group and the field comparisons are all ANDed together
 * - multiple operators on a *single* field are ORed, so `{ age: { gt: 1, lt: 5 } }` is `(age > 1 OR age < 5)`
 * - a key naming a relation is a nested filter on that relation, and becomes an `EXISTS` subquery
 */
export class WhereBuilder<Entity> {
  constructor(
    private readonly tableMeta: TableMeta<Entity>,
    private readonly comparisonBuilder: ComparisonBuilder<Entity> = new ComparisonBuilder<Entity>(),
    private readonly resolveRelation?: RelationResolver
  ) {}

  /**
   * @param filter - the filter to translate.
   * @param resolveColumn - overrides how field names map to columns. Required when building conditions for
   * Drizzle's relational query builder, whose tables are aliased. Defaults to this builder's own table.
   */
  public build(filter: Filter<Entity>, resolveColumn: ColumnResolver = this.tableMeta.resolver()): SQL | undefined {
    const { and: andFilters, or: orFilters } = filter
    const conditions: SQL[] = []

    if (andFilters?.length) {
      const built = andFilters.map((f) => this.build(f, resolveColumn)).filter(isDefined)
      if (built.length) {
        conditions.push(and(...built))
      }
    }

    if (orFilters?.length) {
      const built = orFilters.map((f) => this.build(f, resolveColumn)).filter(isDefined)
      if (built.length) {
        conditions.push(or(...built))
      }
    }

    conditions.push(...this.filterFields(filter, resolveColumn))

    if (!conditions.length) {
      return undefined
    }

    return and(...conditions)
  }

  private filterFields(filter: Filter<Entity>, resolveColumn: ColumnResolver): SQL[] {
    return Object.keys(filter)
      .filter((field) => field !== 'and' && field !== 'or')
      .map((field) =>
        this.withFilterComparison(field as keyof Entity, this.getField(filter, field as keyof Entity), resolveColumn)
      )
      .filter(isDefined)
  }

  private getField<K extends keyof FilterComparisons<Entity>>(
    obj: FilterComparisons<Entity>,
    field: K
  ): FilterFieldComparison<Entity[K]> {
    return obj[field] as FilterFieldComparison<Entity[K]>
  }

  private withFilterComparison<F extends keyof Entity>(
    field: F,
    cmp: FilterFieldComparison<Entity[F]>,
    resolveColumn: ColumnResolver
  ): SQL | undefined {
    if (!cmp) {
      return undefined
    }

    const relationMeta = this.resolveRelation?.(field as string)
    if (relationMeta) {
      return this.relationExists(relationMeta, cmp as Filter<unknown>, resolveColumn)
    }

    const column = resolveColumn(field as string)
    const operators = Object.keys(cmp) as (keyof FilterFieldComparison<Entity[F]>)[]
    const comparisons = operators.map((operator) =>
      this.comparisonBuilder.build(field, operator, cmp[operator] as ComparisonField<Entity, F>, column)
    )

    if (!comparisons.length) {
      return undefined
    }

    return or(...comparisons)
  }

  /**
   * Translates `{ subTasks: { title: { eq: 'x' } } }` into `EXISTS (select 1 from sub_task <alias> where <alias>
   * correlates to this row AND <nested filter>)`.
   *
   * A correlated `EXISTS` rather than a join, because the join `query-typeorm` uses multiplies parent rows for a
   * to-many relation and then has to de-duplicate them; `EXISTS` expresses "has at least one matching row"
   * directly, which is the semantics the generated schema promises and what paging and `totalCount` need.
   *
   * The nested filter recurses through {@link build}, so relation filters get exactly the same operator vocabulary
   * and the same OR-per-field composition as a filter on the queried table itself.
   */
  private relationExists(
    relationMeta: RelationMeta<unknown, unknown>,
    filter: Filter<unknown>,
    resolveColumn: ColumnResolver
  ): SQL | undefined {
    const { targetMeta, through } = relationMeta
    // Always alias: a self-referencing relation would otherwise resolve the subquery's columns against the outer
    // occurrence of the same table, silently turning the correlation into a tautology.
    const target = aliasedTable(targetMeta.table, RELATION_ALIAS)
    const targetColumns = target as unknown as Record<string, PgColumn>
    const targetResolver = targetMeta.resolver(targetColumns)
    const conditions: SQL[] = []

    let from = sql`${getTableAsAliasSQL(target)}`

    if (through) {
      const junction = aliasedTable(through.table, THROUGH_ALIAS)
      const junctionColumns = junction as unknown as Record<string, PgColumn>
      const joinCondition = and(
        ...through.targetFields.map((field, index) => eq(junctionColumns[field], targetColumns[relationMeta.targetFields[index]]))
      )

      from = sql`${getTableAsAliasSQL(target)} inner join ${getTableAsAliasSQL(junction)} on ${joinCondition}`
      // The parent is reached through the junction, so the correlation lands on the junction's source columns.
      conditions.push(
        ...through.sourceFields.map((field, index) => eq(junctionColumns[field], resolveColumn(relationMeta.sourceFields[index])))
      )
    } else {
      conditions.push(
        ...relationMeta.targetFields.map((field, index) =>
          eq(targetColumns[field], resolveColumn(relationMeta.sourceFields[index]))
        )
      )
    }

    // Re-rendered against the alias -- the cached `predefinedWhere` names the real table and would not bind here.
    const predefinedWhere = relationMeta.predefinedWhereOn(target)
    if (predefinedWhere) {
      conditions.push(predefinedWhere)
    }

    // No relation resolver for the nested builder: `query-graphql` generates relation filters exactly one level
    // deep (`TodoItemFilterSubTaskFilter` has no relation keys), so a relation name here is a genuine bad request
    // and should reach the unknown-field guard rather than a second subquery.
    const nested = new WhereBuilder(targetMeta).build(filter, targetResolver)

    if (!nested) {
      // An empty relation filter carries no predicate. `query-typeorm` left-joins and keeps every parent, so
      // narrowing to "has at least one related row" here would silently disagree with the other adapters.
      return undefined
    }

    conditions.push(nested)

    return exists(sql`(select 1 from ${from} where ${and(...conditions)})`)
  }
}
