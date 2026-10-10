import { BadRequestException } from '@nestjs/common'
import { CommonFieldComparisonBetweenType, FilterComparisonOperators } from '@ptc-org/nestjs-query-core'
import {
  between,
  Column,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notBetween,
  notIlike,
  notInArray,
  notLike,
  SQL
} from 'drizzle-orm'

/**
 * @internal
 */
export type ComparisonField<Entity, F extends keyof Entity> =
  | Entity[F]
  | Entity[F][]
  | CommonFieldComparisonBetweenType<Entity[F]>
  | true
  | false
  | null

type SimpleComparison = (column: Column, value: unknown) => SQL

/**
 * @internal
 * Translates a single `Filter` operator (eq, neq, gt, in, like, ...) into a Drizzle condition.
 *
 * Operator names are normalized to lower case so the `iLike`/`notILike` casing used by
 * `@ptc-org/nestjs-query-core` maps onto Drizzle's `ilike`/`notIlike`.
 */
export class ComparisonBuilder<Entity> {
  static DEFAULT_COMPARISON_MAP: Record<string, SimpleComparison> = {
    eq: (column, value) => eq(column, value),
    neq: (column, value) => ne(column, value),
    gt: (column, value) => gt(column, value),
    gte: (column, value) => gte(column, value),
    lt: (column, value) => lt(column, value),
    lte: (column, value) => lte(column, value),
    like: (column, value) => like(column, value as string),
    notlike: (column, value) => notLike(column, value as string),
    ilike: (column, value) => ilike(column, value as string),
    notilike: (column, value) => notIlike(column, value as string)
  }

  constructor(readonly comparisonMap: Record<string, SimpleComparison> = ComparisonBuilder.DEFAULT_COMPARISON_MAP) {}

  public build<F extends keyof Entity>(
    field: F,
    cmp: FilterComparisonOperators<Entity[F]>,
    val: ComparisonField<Entity, F>,
    column: Column
  ): SQL {
    const normalizedCmp = (cmp as string).toLowerCase()
    const simpleComparison = this.comparisonMap[normalizedCmp]

    if (simpleComparison) {
      return simpleComparison(column, val)
    }

    switch (normalizedCmp) {
      case 'is':
        return this.isComparison(column, val, field)
      case 'isnot':
        return this.isNotComparison(column, val, field)
      case 'in':
        return inArray(column, this.assertNonEmptyArray(val, field, 'in'))
      case 'notin':
        return notInArray(column, this.assertNonEmptyArray(val, field, 'notIn'))
      case 'between': {
        const { lower, upper } = this.assertBetween(val, field, 'between')
        return between(column, lower, upper)
      }
      case 'notbetween': {
        const { lower, upper } = this.assertBetween(val, field, 'notBetween')
        return notBetween(column, lower, upper)
      }
      default:
        throw new BadRequestException(`unknown comparison operator "${String(cmp)}" for field "${String(field)}"`)
    }
  }

  private isComparison<F extends keyof Entity>(column: Column, val: ComparisonField<Entity, F>, field: F): SQL {
    if (val === null) {
      return isNull(column)
    }
    if (val === true || val === false) {
      return eq(column, val)
    }

    throw new BadRequestException(`unexpected "is" operator value ${JSON.stringify(val)} for field "${String(field)}"`)
  }

  private isNotComparison<F extends keyof Entity>(column: Column, val: ComparisonField<Entity, F>, field: F): SQL {
    if (val === null) {
      return isNotNull(column)
    }
    if (val === true || val === false) {
      return ne(column, val)
    }

    throw new BadRequestException(`unexpected "isNot" operator value ${JSON.stringify(val)} for field "${String(field)}"`)
  }

  private assertNonEmptyArray<F extends keyof Entity>(val: ComparisonField<Entity, F>, field: F, cmp: string): unknown[] {
    if (!Array.isArray(val)) {
      throw new BadRequestException(`invalid "${cmp}" value for field "${String(field)}", expected an array`)
    }
    if (!val.length) {
      throw new BadRequestException(`invalid "${cmp}" value for field "${String(field)}", expected a non-empty array`)
    }

    return val as unknown[]
  }

  private assertBetween<F extends keyof Entity>(
    val: ComparisonField<Entity, F>,
    field: F,
    cmp: string
  ): CommonFieldComparisonBetweenType<Entity[F]> {
    if (val !== null && typeof val === 'object' && 'lower' in val && 'upper' in val) {
      return val
    }

    throw new BadRequestException(
      `invalid "${cmp}" value for field "${String(field)}", expected {lower: val, upper: val} got ${JSON.stringify(val)}`
    )
  }
}
