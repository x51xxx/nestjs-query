import { BadRequestException, ConflictException, MethodNotAllowedException, NotFoundException } from '@nestjs/common'
import { SortDirection } from '@ptc-org/nestjs-query-core'

import { DrizzleQueryService } from '../../src/services'
import { DrizzleDatabase } from '../../src/typings'
import { createStubDb, StubDb } from '../__fixtures__/db.fixture'
import { testRelations } from '../__fixtures__/relations.fixture'
import { TestEntityDTO } from '../__fixtures__/test-table'

/** Positional row matching the table's column order: id, stringType, numberType, boolType, dateType. */
const ROW = [1, 'foo', 5, true, null]
const ENTITY = { id: 1, stringType: 'foo', numberType: 5, boolType: true, dateType: null }

describe('DrizzleQueryService', () => {
  let stub: StubDb
  let service: DrizzleQueryService<TestEntityDTO>

  beforeEach(() => {
    stub = createStubDb()
    service = new DrizzleQueryService<TestEntityDTO>(stub.db, TestEntityDTO, 'testTable', testRelations)
  })

  describe('constructor', () => {
    it('should throw for a table that is not in the relations config', () => {
      expect(() => new DrizzleQueryService<TestEntityDTO>(stub.db, TestEntityDTO, 'nope', testRelations)).toThrow(
        /Unknown table "nope"/
      )
    })

    it('should expose the resolved primary key', () => {
      expect(service.tableMeta.primaryKey.field).toBe('id')
    })

    it('should fail at bootstrap when drizzle() was created without the same relations', () => {
      const dbWithoutRelations = { query: {} } as unknown as DrizzleDatabase

      expect(() => new DrizzleQueryService<TestEntityDTO>(dbWithoutRelations, TestEntityDTO, 'testTable', testRelations)).toThrow(
        /same relations object.*drizzle\(\)/
      )
    })

    it('should reject unknown relationOptions keys', () => {
      expect(
        () =>
          new DrizzleQueryService<TestEntityDTO>(stub.db, TestEntityDTO, 'testTable', testRelations, {
            typo: { foreignKeySide: 'target' }
          })
      ).toThrow(/Unknown relationOptions.*typo/)
    })
  })

  describe('#query', () => {
    it('should export through the same query path', async () => {
      stub.queueRows([ROW])

      await expect(service.exportMany({ filter: { stringType: { eq: 'foo' } } })).resolves.toEqual([ENTITY])
      expect(stub.lastQuery().sql).toContain('where "test_entity"."string_type" = $1')
    })

    it('should apply the filter, sorting and paging', async () => {
      stub.queueRows([ROW])

      const result = await service.query({
        filter: { stringType: { eq: 'foo' } },
        sorting: [{ field: 'id', direction: SortDirection.DESC }],
        paging: { limit: 10, offset: 5 }
      })

      expect(stub.lastQuery().sql).toBe(
        'select "id", "string_type", "number_type", "bool_type", "date_type" from "test_entity" ' +
          'where "test_entity"."string_type" = $1 order by "test_entity"."id" desc limit $2 offset $3'
      )
      expect(stub.lastQuery().params).toEqual(['foo', 10, 5])
      expect(result).toEqual([ENTITY])
    })
  })

  describe('#count', () => {
    it('should count with a filter', async () => {
      stub.queueRows([['3']])

      await expect(service.count({ boolType: { is: true } })).resolves.toBe(3)
      expect(stub.lastQuery().sql).toContain('count(')
      expect(stub.lastQuery().params).toEqual([true])
    })
  })

  describe('relation filters', () => {
    it('should apply a relation filter to a plain query', async () => {
      stub.queueRows([[...ROW]])

      await expect(service.query({ filter: { testRelations: { relationName: { eq: 'x' } } } as never })).resolves.toEqual([
        ENTITY
      ])

      const { sql, params } = stub.lastQuery()
      expect(sql).toContain('exists (select 1 from "test_relation" as "__nq_rel"')
      expect(sql).toContain('"__nq_rel"."test_entity_id" = "test_entity"."id"')
      expect(params).toEqual(['x'])
    })

    it('should apply a relation filter to count and aggregate', async () => {
      // Both route through the same `whereClause`, but the schema exposes relation keys on the aggregate filter
      // too, so the wiring is asserted rather than assumed.
      stub.queueRows([['2']], [[2]])

      await expect(service.count({ tags: { tagName: { eq: 'urgent' } } } as never)).resolves.toBe(2)
      expect(stub.lastQuery().sql).toContain('"__nq_rel_through"."test_entity_id" = "test_entity"."id"')

      await service.aggregate({ testRelations: { relationName: { eq: 'y' } } } as never, {
        count: [{ field: 'id', args: {} }]
      })
      expect(stub.lastQuery().sql).toContain('exists (select 1 from "test_relation" as "__nq_rel"')
    })

    it('should still reject a key that is neither a column nor a relation', async () => {
      await expect(service.query({ filter: { nope: { eq: 1 } } as never })).rejects.toThrow(/Unknown field "nope"/)
    })
  })

  describe('#aggregate', () => {
    it('should aggregate and coerce numeric results', async () => {
      stub.queueRows([[2, '10']])

      const result = await service.aggregate(
        { boolType: { is: true } },
        {
          count: [{ field: 'id', args: {} }],
          sum: [{ field: 'numberType', args: {} }]
        }
      )

      expect(stub.lastQuery().sql).toBe(
        'select count("id"), sum("number_type") from "test_entity" where "test_entity"."bool_type" = $1'
      )
      expect(result).toEqual([{ count: { id: 2 }, sum: { numberType: 10 } }])
      expect(typeof result[0].sum?.numberType).toBe('number')
    })
  })

  describe('#findById', () => {
    it('should select by primary key with a limit', async () => {
      stub.queueRows([ROW])

      await expect(service.findById(1)).resolves.toEqual(ENTITY)
      expect(stub.lastQuery().sql).toContain('where "test_entity"."id" = $1')
      expect(stub.lastQuery().sql).toContain('limit $2')
    })

    it('should AND an additional filter with the id', async () => {
      stub.queueRows([ROW])

      await service.findById(1, { filter: { stringType: { eq: 'foo' } } })

      expect(stub.lastQuery().sql).toContain('where (("test_entity"."id" = $1) and ("test_entity"."string_type" = $2))')
      expect(stub.lastQuery().params).toEqual([1, 'foo', 1])
    })

    it('should resolve undefined when not found', async () => {
      stub.queueRows([])

      await expect(service.findById(1)).resolves.toBeUndefined()
    })
  })

  describe('#getById', () => {
    it('should resolve the entity when found', async () => {
      stub.queueRows([ROW])

      await expect(service.getById(1)).resolves.toEqual(ENTITY)
    })

    it('should reject with NotFoundException when missing', async () => {
      stub.queueRows([])

      await expect(service.getById(1)).rejects.toThrow(NotFoundException)
    })
  })

  describe('#createOne', () => {
    it('should insert and return the created row', async () => {
      stub.queueRows([ROW])

      await expect(service.createOne({ stringType: 'foo' })).resolves.toEqual(ENTITY)
      expect(stub.lastQuery().sql).toContain('insert into "test_entity"')
      expect(stub.lastQuery().sql).toContain('returning')
    })

    it('should reject when an entity with the given id already exists', async () => {
      stub.queueError(Object.assign(new Error('duplicate key'), { code: '23505' }))

      await expect(service.createOne({ id: 1, stringType: 'foo' })).rejects.toThrow(ConflictException)
    })

    it('should reject a record that does not match the creation filter, without querying', async () => {
      await expect(service.createOne({ stringType: 'foo' }, { filter: { stringType: { eq: 'bar' } } })).rejects.toThrow(
        BadRequestException
      )
      expect(stub.captured).toHaveLength(0)
    })

    it('should insert a record that matches the creation filter', async () => {
      stub.queueRows([ROW])

      await expect(service.createOne({ stringType: 'foo' }, { filter: { stringType: { eq: 'foo' } } })).resolves.toEqual(ENTITY)
    })

    it('should insert in one statement without an existence check', async () => {
      stub.queueRows([ROW])

      await service.createOne({ stringType: 'foo' })

      expect(stub.captured).toHaveLength(1)
    })
  })

  describe('#createMany', () => {
    it('should insert multiple rows', async () => {
      stub.queueRows([ROW, [2, 'bar', 6, false, null]])

      const result = await service.createMany([{ stringType: 'foo' }, { stringType: 'bar' }])

      expect(result).toHaveLength(2)
      expect(stub.lastQuery().sql).toContain('insert into "test_entity"')
    })

    it('should short-circuit on an empty array without querying', async () => {
      await expect(service.createMany([])).resolves.toEqual([])
      expect(stub.captured).toHaveLength(0)
    })

    it('should skip records that do not match the creation filter', async () => {
      stub.queueRows([ROW])

      const result = await service.createMany([{ stringType: 'foo' }, { stringType: 'bar' }], {
        filter: { stringType: { eq: 'foo' } }
      })

      expect(result).toEqual([ENTITY])
      expect(stub.lastQuery().params).toContain('foo')
      expect(stub.lastQuery().params).not.toContain('bar')
    })

    it('should not query when no record matches the creation filter', async () => {
      await expect(service.createMany([{ stringType: 'bar' }], { filter: { stringType: { eq: 'foo' } } })).resolves.toEqual([])
      expect(stub.captured).toHaveLength(0)
    })

    it('should reject the whole insert on a unique violation', async () => {
      stub.queueError(Object.assign(new Error('duplicate key'), { code: '23505' }))

      await expect(service.createMany([{ id: 1 }, { id: 1 }])).rejects.toThrow(ConflictException)
      expect(stub.captured).toHaveLength(1)
    })
  })

  describe('#updateOne', () => {
    it('should reject when the update contains the id', async () => {
      await expect(service.updateOne(1, { id: 2 } as never)).rejects.toThrow('Id cannot be specified when updating')
      expect(stub.captured).toHaveLength(0)
    })

    it('should reject with NotFoundException when the entity is missing', async () => {
      stub.queueRows([])

      await expect(service.updateOne(1, { stringType: 'bar' })).rejects.toThrow(NotFoundException)
    })

    it('should update and return the updated row', async () => {
      stub.queueRows([[1, 'bar', 5, true, null]])

      const result = await service.updateOne(1, { stringType: 'bar' })

      expect(stub.lastQuery().sql).toContain('update "test_entity" set "string_type" = $1')
      expect(result).toEqual({ ...ENTITY, stringType: 'bar' })
    })

    it('should reject when the row disappears before UPDATE returns', async () => {
      stub.queueRows([])

      await expect(service.updateOne(1, { stringType: 'bar' })).rejects.toThrow(NotFoundException)
    })
  })

  describe('#updateMany', () => {
    it('should return the number of updated rows', async () => {
      stub.queueRows([[1], [2]])

      const result = await service.updateMany({ stringType: 'bar' }, { boolType: { is: true } })

      expect(result).toEqual({ updatedCount: 2 })
      expect(stub.lastQuery().sql).toContain('update "test_entity" set "string_type" = $1')
      expect(stub.lastQuery().sql).toContain('where "test_entity"."bool_type" = $2')
    })

    it('should reject when the update contains the id', async () => {
      await expect(service.updateMany({ id: 2 } as never, {})).rejects.toThrow('Id cannot be specified when updating')
    })
  })

  describe('#deleteOne', () => {
    it('should return the deleted entity', async () => {
      stub.queueRows([ROW])

      await expect(service.deleteOne(1)).resolves.toEqual(ENTITY)
      expect(stub.lastQuery().sql).toContain('delete from "test_entity"')
    })

    it('should reject with NotFoundException when the entity is missing', async () => {
      stub.queueRows([])

      await expect(service.deleteOne(1)).rejects.toThrow(NotFoundException)
    })

    it('should reject soft delete without issuing SQL', async () => {
      await expect(service.deleteOne(1, { useSoftDelete: true })).rejects.toThrow(MethodNotAllowedException)
      expect(stub.captured).toHaveLength(0)
    })
  })

  describe('#deleteMany', () => {
    it('should return the number of deleted rows', async () => {
      stub.queueRows([[1], [2], [3]])

      const result = await service.deleteMany({ boolType: { is: false } })

      expect(result).toEqual({ deletedCount: 3 })
      expect(stub.lastQuery().sql).toContain('delete from "test_entity"')
    })

    it('should reject soft delete without issuing SQL', async () => {
      await expect(service.deleteMany({}, { useSoftDelete: true })).rejects.toThrow(MethodNotAllowedException)
      expect(stub.captured).toHaveLength(0)
    })
  })
})
