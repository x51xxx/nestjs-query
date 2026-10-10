import { BadRequestException } from '@nestjs/common'
import { Query, SortDirection, SortNulls } from '@ptc-org/nestjs-query-core'
import { QueryBuilder } from 'drizzle-orm/pg-core'

import { FilterQueryBuilder, TableMeta } from '../../src/query'
import { TestEntityDTO, testTable } from '../__fixtures__/test-table'

const tableMeta = new TableMeta<TestEntityDTO>(testTable, 'testTable')
const filterQueryBuilder = new FilterQueryBuilder<TestEntityDTO>(tableMeta)
const queryBuilder = new QueryBuilder()

const applyQuery = (query: Query<TestEntityDTO>): { sql: string; params: unknown[] } => {
  const qb = filterQueryBuilder.applyQuery(queryBuilder.select().from(testTable).$dynamic(), query)
  const { sql, params } = qb.toSQL()

  return {
    sql: sql.replace('select "id", "string_type", "number_type", "bool_type", "date_type" from ', 'select * from '),
    params
  }
}

describe('FilterQueryBuilder', () => {
  it('should build a bare select for an empty query', () => {
    expect(applyQuery({}).sql).toBe('select * from "test_entity"')
  })

  it('should apply a filter', () => {
    const { sql, params } = applyQuery({ filter: { stringType: { eq: 'foo' } } })

    expect(sql).toBe('select * from "test_entity" where "test_entity"."string_type" = $1')
    expect(params).toEqual(['foo'])
  })

  it('should apply sorting', () => {
    const { sql } = applyQuery({
      sorting: [
        { field: 'stringType', direction: SortDirection.ASC },
        { field: 'numberType', direction: SortDirection.DESC }
      ]
    })

    expect(sql).toBe('select * from "test_entity" order by "test_entity"."string_type" asc, "test_entity"."number_type" desc')
  })

  it('should reject sorting by a non-column field as a bad request', () => {
    expect(() => applyQuery({ sorting: [{ field: 'relation' as keyof TestEntityDTO, direction: SortDirection.ASC }] })).toThrow(
      BadRequestException
    )
  })

  it.each([
    [SortDirection.ASC, SortNulls.NULLS_FIRST, 'asc nulls first'],
    [SortDirection.ASC, SortNulls.NULLS_LAST, 'asc nulls last'],
    [SortDirection.DESC, SortNulls.NULLS_FIRST, 'desc nulls first'],
    [SortDirection.DESC, SortNulls.NULLS_LAST, 'desc nulls last']
  ])('should apply %s sorting with %s', (direction, nulls, expected) => {
    const { sql } = applyQuery({ sorting: [{ field: 'numberType', direction, nulls }] })

    expect(sql).toBe(`select * from "test_entity" order by "test_entity"."number_type" ${expected}`)
  })

  it('should apply paging', () => {
    const { sql, params } = applyQuery({ paging: { limit: 10, offset: 20 } })

    expect(sql).toBe('select * from "test_entity" limit $1 offset $2')
    expect(params).toEqual([10, 20])
  })

  it('should apply an offset without a limit', () => {
    expect(applyQuery({ paging: { offset: 5 } }).sql).toBe('select * from "test_entity" offset $1')
  })

  it('should apply filter, sorting and paging together', () => {
    const { sql, params } = applyQuery({
      filter: { boolType: { is: true } },
      sorting: [{ field: 'id', direction: SortDirection.ASC }],
      paging: { limit: 5 }
    })

    expect(sql).toBe('select * from "test_entity" where "test_entity"."bool_type" = $1 order by "test_entity"."id" asc limit $2')
    expect(params).toEqual([true, 5])
  })

  it('should return no where clause for an undefined filter', () => {
    expect(filterQueryBuilder.whereClause(undefined)).toBeUndefined()
  })
})
