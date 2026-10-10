import { BadRequestException } from '@nestjs/common'
import { FilterComparisonOperators } from '@ptc-org/nestjs-query-core'
import { QueryBuilder } from 'drizzle-orm/pg-core'

import { ComparisonBuilder, ComparisonField, TableMeta } from '../../src/query'
import { TestEntityDTO, testTable } from '../__fixtures__/test-table'

const tableMeta = new TableMeta<TestEntityDTO>(testTable, 'testTable')
const queryBuilder = new QueryBuilder()

const build = <F extends keyof TestEntityDTO>(
  field: F,
  cmp: string,
  val: ComparisonField<TestEntityDTO, F>
): { sql: string; params: unknown[] } => {
  const condition = new ComparisonBuilder<TestEntityDTO>().build(
    field,
    cmp as FilterComparisonOperators<TestEntityDTO[F]>,
    val,
    tableMeta.column(field)
  )
  const { sql, params } = queryBuilder.select().from(testTable).where(condition).toSQL()

  return { sql: sql.split(' where ')[1] ?? '', params }
}

describe('ComparisonBuilder', () => {
  describe('comparison operators', () => {
    it.each([
      ['eq', '=', 1],
      ['neq', '<>', 1],
      ['gt', '>', 1],
      ['gte', '>=', 1],
      ['lt', '<', 1],
      ['lte', '<=', 1]
    ])('should map %s to %s', (cmp, operator, value) => {
      const { sql, params } = build('numberType', cmp, value)

      expect(sql).toBe(`"test_entity"."number_type" ${operator} $1`)
      expect(params).toEqual([value])
    })

    it.each([
      ['like', 'like'],
      ['notLike', 'not like'],
      ['iLike', 'ilike'],
      ['notILike', 'not ilike']
    ])('should map %s to %s', (cmp, operator) => {
      const { sql, params } = build('stringType', cmp, 'foo%')

      expect(sql).toBe(`"test_entity"."string_type" ${operator} $1`)
      expect(params).toEqual(['foo%'])
    })
  })

  describe('is / isNot', () => {
    it('should map `is: null` to IS NULL', () => {
      expect(build('boolType', 'is', null).sql).toBe('("test_entity"."bool_type" is null)')
    })

    it('should map `isNot: null` to IS NOT NULL', () => {
      expect(build('boolType', 'isNot', null).sql).toBe('("test_entity"."bool_type" is not null)')
    })

    it.each([true, false])('should map `is: %s` to an equality check', (value) => {
      const { sql, params } = build('boolType', 'is', value)

      expect(sql).toBe('"test_entity"."bool_type" = $1')
      expect(params).toEqual([value])
    })

    it.each([true, false])('should map `isNot: %s` to an inequality check', (value) => {
      const { sql, params } = build('boolType', 'isNot', value)

      expect(sql).toBe('"test_entity"."bool_type" <> $1')
      expect(params).toEqual([value])
    })

    it('should reject a non-boolean `is` value', () => {
      expect(() => build('boolType', 'is', 'nope' as never)).toThrow(BadRequestException)
    })
  })

  describe('in / notIn', () => {
    it('should map in to IN', () => {
      const { sql, params } = build('numberType', 'in', [1, 2, 3])

      expect(sql).toBe('"test_entity"."number_type" in ($1, $2, $3)')
      expect(params).toEqual([1, 2, 3])
    })

    it('should map notIn to NOT IN', () => {
      expect(build('numberType', 'notIn', [1]).sql).toBe('"test_entity"."number_type" not in ($1)')
    })

    it.each(['in', 'notIn'])('should reject an empty %s array', (cmp) => {
      expect(() => build('numberType', cmp, [])).toThrow(/expected a non-empty array/)
    })

    it.each(['in', 'notIn'])('should reject a non-array %s value', (cmp) => {
      expect(() => build('numberType', cmp, 1)).toThrow(/expected an array/)
    })
  })

  describe('between / notBetween', () => {
    it('should map between to BETWEEN', () => {
      const { sql, params } = build('numberType', 'between', { lower: 1, upper: 10 })

      expect(sql).toBe('"test_entity"."number_type" between $1 and $2')
      expect(params).toEqual([1, 10])
    })

    it('should map notBetween to NOT BETWEEN', () => {
      expect(build('numberType', 'notBetween', { lower: 1, upper: 10 }).sql).toBe(
        '"test_entity"."number_type" not between $1 and $2'
      )
    })

    it.each(['between', 'notBetween'])('should reject a malformed %s value', (cmp) => {
      expect(() => build('numberType', cmp, { lower: 1 } as never)).toThrow(/expected \{lower: val, upper: val\}/)
    })
  })

  it('should reject an unknown operator', () => {
    expect(() => build('numberType', 'notAnOperator', 1)).toThrow(/unknown comparison operator "notAnOperator"/)
  })
})
