import { BadRequestException } from '@nestjs/common'
import { GroupBy } from '@ptc-org/nestjs-query-core'
import { QueryBuilder } from 'drizzle-orm/pg-core'

import { AggregateBuilder, TableMeta } from '../../src/query'
import { TestEntityDTO, testTable } from '../__fixtures__/test-table'

const tableMeta = new TableMeta<TestEntityDTO>(testTable, 'testTable')
const aggregateBuilder = new AggregateBuilder<TestEntityDTO>(tableMeta)
const queryBuilder = new QueryBuilder()

describe('AggregateBuilder', () => {
  it('should throw when no aggregate fields are provided', () => {
    expect(() => aggregateBuilder.build({})).toThrow(BadRequestException)
  })

  it('should build a select for every aggregate function', () => {
    const { selection } = aggregateBuilder.build({
      count: [{ field: 'id', args: {} }],
      sum: [{ field: 'numberType', args: {} }],
      avg: [{ field: 'numberType', args: {} }],
      max: [{ field: 'id', args: {} }],
      min: [{ field: 'id', args: {} }]
    })

    expect(queryBuilder.select(selection).from(testTable).toSQL().sql).toBe(
      'select count("id"), sum("number_type"), avg("number_type"), max("id"), min("id") from "test_entity"'
    )
  })

  it('should convert rows into an AggregateResponse', () => {
    const { convert } = aggregateBuilder.build({
      count: [{ field: 'id', args: {} }],
      max: [{ field: 'stringType', args: {} }]
    })

    expect(convert([{ agg_0: 3, agg_1: 'zzz' }])).toEqual([{ count: { id: 3 }, max: { stringType: 'zzz' } }])
  })

  it('should coerce count/sum/avg to numbers', () => {
    const { convert } = aggregateBuilder.build({
      count: [{ field: 'id', args: {} }],
      sum: [{ field: 'numberType', args: {} }],
      avg: [{ field: 'numberType', args: {} }]
    })

    // Postgres returns `numeric` aggregates as strings, but AggregateResponse types them as numbers.
    const [response] = convert([{ agg_0: 3, agg_1: '10', agg_2: '2.5' }])

    expect(typeof response.count?.id).toBe('number')
    expect(typeof response.sum?.numberType).toBe('number')
    expect(typeof response.avg?.numberType).toBe('number')
    expect(response).toEqual({ count: { id: 3 }, sum: { numberType: 10 }, avg: { numberType: 2.5 } })
  })

  it('should preserve null for an aggregate over no rows', () => {
    const { convert } = aggregateBuilder.build({ sum: [{ field: 'numberType', args: {} }] })

    expect(convert([{ agg_0: null }])).toEqual([{ sum: { numberType: null } }])
  })

  it('should not coerce max/min, which keep the column type', () => {
    const { convert } = aggregateBuilder.build({ max: [{ field: 'stringType', args: {} }] })

    expect(convert([{ agg_0: '10' }])).toEqual([{ max: { stringType: '10' } }])
  })

  describe('groupBy', () => {
    it('should group by a plain column', () => {
      const { selection, groupBy, convert } = aggregateBuilder.build({
        groupBy: [{ field: 'boolType', args: {} }],
        count: [{ field: 'id', args: {} }]
      })

      expect(groupBy).toHaveLength(1)
      expect(
        queryBuilder
          .select(selection)
          .from(testTable)
          .groupBy(...groupBy)
          .toSQL().sql
      ).toBe('select "bool_type", count("id") from "test_entity" group by "test_entity"."bool_type"')
      expect(convert([{ agg_0: true, agg_1: 2 }])).toEqual([{ groupBy: { boolType: true }, count: { id: 2 } }])
    })

    it.each([
      [GroupBy.DAY, 'day'],
      [GroupBy.WEEK, 'week'],
      [GroupBy.MONTH, 'month'],
      [GroupBy.YEAR, 'year']
    ])('should bucket dates by %s, keeping the column type', (by, unit) => {
      const { selection } = aggregateBuilder.build({ groupBy: [{ field: 'dateType', args: { by } }] })

      expect(queryBuilder.select(selection).from(testTable).toSQL().sql).toBe(
        `select CAST(DATE_TRUNC('${unit}', "date_type") AS timestamp) from "test_entity"`
      )
    })

    it('should decode a bucketed date with the column`s own decoder', () => {
      const { selection } = aggregateBuilder.build({ groupBy: [{ field: 'dateType', args: { by: GroupBy.DAY } }] })

      // Drizzle's drivers decode by the selected column; without it a bucket comes back as a raw string, which
      // GraphQL's DateTime scalar serializes to null. The real-driver behaviour is covered by the drizzle e2e.
      expect((selection.agg_0 as unknown as { decoder: unknown }).decoder).toBe(tableMeta.columns.dateType)
    })
  })
})
