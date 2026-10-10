import { BadRequestException } from '@nestjs/common'
import { Filter } from '@ptc-org/nestjs-query-core'
import { QueryBuilder } from 'drizzle-orm/pg-core'

import { RelationMeta, TableMeta, WhereBuilder } from '../../src/query'
import {
  relationsWithPredefinedWhere,
  selfReferencingRelations,
  selfRefNode,
  SelfRefNodeDTO,
  testRelations
} from '../__fixtures__/relations.fixture'
import { TestEntityDTO, testTable } from '../__fixtures__/test-table'

const tableMeta = new TableMeta<TestEntityDTO>(testTable, 'testTable')
const queryBuilder = new QueryBuilder()

/**
 * Resolves the relations of `testTable` for the builder under test. Mirrors what `DrizzleQueryService` installs,
 * without needing a database.
 */
const relationResolver =
  (relations: typeof testRelations = testRelations) =>
  (field: string) =>
    relations.testTable.relations[field]
      ? (new RelationMeta(tableMeta, field, relations.testTable, relations) as RelationMeta<unknown, unknown>)
      : undefined

/**
 * Returns just the WHERE fragment (and its params) so assertions stay readable. Split on the *first* ` where `
 * only: a relation filter's subquery carries a `where` of its own, and `String.split` would drop everything past
 * it.
 */
const buildWhere = (filter: Filter<TestEntityDTO>, relations?: typeof testRelations): { sql: string; params: unknown[] } => {
  const builder = new WhereBuilder<TestEntityDTO>(
    tableMeta,
    undefined,
    relations === undefined ? undefined : relationResolver(relations)
  )
  const { sql, params } = queryBuilder.select().from(testTable).where(builder.build(filter)).toSQL()
  const at = sql.indexOf(' where ')

  return { sql: at === -1 ? '' : sql.slice(at + ' where '.length), params }
}

describe('WhereBuilder', () => {
  it('should return undefined for an empty filter', () => {
    expect(new WhereBuilder<TestEntityDTO>(tableMeta).build({})).toBeUndefined()
  })

  it('should OR multiple operators for a single field together', () => {
    // Matches the other adapters: operators on one field are ORed, NOT ANDed.
    const { sql, params } = buildWhere({ numberType: { gt: 10, lt: 20 } })

    expect(sql).toBe('(("test_entity"."number_type" > $1) or ("test_entity"."number_type" < $2))')
    expect(params).toEqual([10, 20])
  })

  it('should AND multiple field comparisons together', () => {
    const { sql, params } = buildWhere({ numberType: { eq: 1 }, stringType: { like: 'foo%' } })

    expect(sql).toBe('(("test_entity"."number_type" = $1) and ("test_entity"."string_type" like $2))')
    expect(params).toEqual([1, 'foo%'])
  })

  it('should AND the entries of an `and` group', () => {
    const { sql, params } = buildWhere({ and: [{ numberType: { gt: 2 } }, { numberType: { lt: 10 } }] })

    expect(sql).toBe('(("test_entity"."number_type" > $1) and ("test_entity"."number_type" < $2))')
    expect(params).toEqual([2, 10])
  })

  it('should OR the entries of an `or` group', () => {
    const { sql, params } = buildWhere({ or: [{ numberType: { eq: 2 } }, { stringType: { eq: 'foo' } }] })

    expect(sql).toBe('(("test_entity"."number_type" = $1) or ("test_entity"."string_type" = $2))')
    expect(params).toEqual([2, 'foo'])
  })

  it('should AND an `or` group with sibling field comparisons', () => {
    const { sql, params } = buildWhere({
      or: [{ numberType: { eq: 2 } }, { numberType: { gt: 10 } }],
      stringType: { eq: 'foo' }
    })

    expect(sql).toBe(
      '(((("test_entity"."number_type" = $1) or ("test_entity"."number_type" > $2))) and ("test_entity"."string_type" = $3))'
    )
    expect(params).toEqual([2, 10, 'foo'])
  })

  it('should support nesting `and` inside `or`', () => {
    const { sql, params } = buildWhere({
      or: [{ and: [{ numberType: { gt: 10 } }, { numberType: { lt: 20 } }] }, { stringType: { eq: 'foo' } }]
    })

    expect(sql).toBe(
      '(((("test_entity"."number_type" > $1) and ("test_entity"."number_type" < $2))) or ("test_entity"."string_type" = $3))'
    )
    expect(params).toEqual([10, 20, 'foo'])
  })

  it('should throw a descriptive error for an unknown field', () => {
    expect(() => buildWhere({ doesNotExist: { eq: 1 } } as unknown as Filter<TestEntityDTO>)).toThrow(BadRequestException)
    expect(() => buildWhere({ doesNotExist: { eq: 1 } } as unknown as Filter<TestEntityDTO>)).toThrow(
      /Unknown field "doesNotExist" on table "testTable"/
    )
  })
  describe('relation filters', () => {
    it('should translate a has-many relation filter into a correlated EXISTS', () => {
      const { sql, params } = buildWhere({ testRelations: { relationName: { eq: 'x' } } } as never, testRelations)

      // A correlated EXISTS rather than a join: a join would multiply parent rows for a to-many relation and then
      // need de-duplicating before paging and totalCount could be trusted.
      expect(sql).toContain('exists (select 1 from "test_relation" as "__nq_rel"')
      expect(sql).toContain('"__nq_rel"."test_entity_id" = "test_entity"."id"')
      expect(sql).toContain('"__nq_rel"."relation_name" = $1')
      expect(params).toEqual(['x'])
    })

    it('should join the junction table for a `through` relation filter', () => {
      const { sql, params } = buildWhere({ tags: { tagName: { eq: 'urgent' } } } as never, testRelations)

      expect(sql).toContain(
        'inner join "test_entity_tags" as "__nq_rel_through" on "__nq_rel_through"."tag_id" = "__nq_rel"."id"'
      )
      // The parent is reached through the junction, so that is where the correlation lands.
      expect(sql).toContain('"__nq_rel_through"."test_entity_id" = "test_entity"."id"')
      expect(params).toEqual(['urgent'])
    })

    it('should compose relation filters through the existing and/or rules', () => {
      const { sql, params } = buildWhere(
        { or: [{ testRelations: { relationName: { eq: 'a' } } }, { tags: { tagName: { eq: 'b' } } }] } as never,
        testRelations
      )

      expect(sql.match(/exists /g)).toHaveLength(2)
      expect(sql).toContain(') or (')
      expect(params).toEqual(['a', 'b'])
    })

    it('should AND a relation filter with the queried table`s own columns', () => {
      const { sql, params } = buildWhere(
        { boolType: { is: true }, testRelations: { relationName: { in: ['a', 'b'] } } } as never,
        testRelations
      )

      expect(sql).toContain('"test_entity"."bool_type" = $1')
      expect(sql).toContain('"__nq_rel"."relation_name" in ($2, $3)')
      expect(params).toEqual([true, 'a', 'b'])
    })

    it('should keep the nested filter`s OR-per-field semantics', () => {
      // Same rule as a top-level filter: operators on one field are ORed, because the nested filter recurses
      // through the very same builder rather than a second translation layer.
      const { sql } = buildWhere({ testRelations: { relationName: { eq: 'a', like: 'b%' } } } as never, testRelations)

      expect(sql).toContain('("__nq_rel"."relation_name" = $1) or ("__nq_rel"."relation_name" like $2)')
    })

    it('should apply the relation`s predefined `where` against the alias, not the real table', () => {
      const { sql } = buildWhere(
        { namedRelations: { relationName: { eq: 'z' } } } as never,
        relationsWithPredefinedWhere as never
      )

      expect(sql).toContain('"__nq_rel"."relation_name" is not null')
      // Naming the real table inside the subquery would either be invalid SQL or bind to an outer occurrence.
      expect(sql).not.toContain('"test_relation"."relation_name" is not null')
    })

    it('should correlate a self-referencing relation against the outer table, not itself', () => {
      // Without the subquery alias both sides would name "node" and the correlation would degenerate into
      // `id = id`, matching every row instead of the row's own children.
      const meta = new TableMeta<SelfRefNodeDTO>(selfRefNode, 'selfRefNode')
      const resolveRelation = (field: string) =>
        selfReferencingRelations.selfRefNode.relations[field]
          ? (new RelationMeta(meta, field, selfReferencingRelations.selfRefNode, selfReferencingRelations) as RelationMeta<
              unknown,
              unknown
            >)
          : undefined
      const where = new WhereBuilder<SelfRefNodeDTO>(meta, undefined, resolveRelation).build({
        children: { name: { eq: 'child' } }
      } as never)
      const { sql } = queryBuilder.select().from(selfRefNode).where(where).toSQL()

      expect(sql).toContain('"__nq_rel"."parent_id" = "node"."id"')
      expect(sql).not.toContain('"node"."parent_id" = "node"."id"')
    })

    it('should ignore an empty relation filter', () => {
      // `query-typeorm` left-joins and keeps every parent for `{ subTasks: {} }`; narrowing to "has at least one
      // related row" here would silently disagree with the other adapters.
      expect(buildWhere({ testRelations: {} } as never, testRelations).sql).toBe('')
    })

    it('should reject a relation key when the builder has no relation resolver', () => {
      expect(() => buildWhere({ testRelations: { relationName: { eq: 'x' } } } as never)).toThrow(BadRequestException)
    })
  })
})
