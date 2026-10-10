import { MethodNotAllowedException } from '@nestjs/common'
import { SortDirection } from '@ptc-org/nestjs-query-core'
import { defineRelations } from 'drizzle-orm'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

import { DrizzleQueryService } from '../../src/services'
import { createStubDb, StubDb } from '../__fixtures__/db.fixture'
import {
  AMBIGUOUS_ACCOUNT_ROW,
  AMBIGUOUS_PROFILE_ROW,
  AmbiguousAccountDTO,
  ambiguousRelations,
  CompositeChildDTO,
  compositeKeyRelations,
  CompositeParentDTO,
  inferredRelations,
  relationsWithPredefinedWhere,
  relationsWithReversedPredefinedWhere,
  testRelations
} from '../__fixtures__/relations.fixture'
import { TestEntityDTO, TestRelationDTO, TestTagDTO } from '../__fixtures__/test-table'

const PARENT_A: TestEntityDTO = { id: 1 } as TestEntityDTO
const PARENT_B: TestEntityDTO = { id: 2 } as TestEntityDTO

const relationRow = (id: number, testEntityId: number) => ({ id, relationName: `rel-${id}`, testEntityId })

describe('RelationQueryService (Drizzle)', () => {
  let stub: StubDb
  let service: DrizzleQueryService<TestEntityDTO>

  beforeEach(() => {
    stub = createStubDb()
    service = new DrizzleQueryService<TestEntityDTO>(stub.db, TestEntityDTO, 'testTable', testRelations)
  })

  describe('#getRelationMeta', () => {
    it('should resolve a `many` relation, normalizing source/target columns', () => {
      const meta = service.getRelationMeta<TestRelationDTO>('testRelations')

      expect(meta.isMany).toBe(true)
      expect(meta.through).toBeUndefined()
      expect(meta.targetMeta.tableName).toBe('testRelationTable')
      expect(meta.sourceColumns.map((c) => c.name)).toEqual(['id'])
      expect(meta.targetColumns.map((c) => c.name)).toEqual(['test_entity_id'])
    })

    it('should resolve a `one` relation from the declaring side', () => {
      const relationService = new DrizzleQueryService<TestRelationDTO>(
        stub.db,
        TestRelationDTO,
        'testRelationTable',
        testRelations
      )
      const meta = relationService.getRelationMeta<TestEntityDTO>('testEntity')

      expect(meta.isMany).toBe(false)
      // Drizzle normalizes: source columns are always on the declaring table.
      expect(meta.sourceColumns.map((c) => c.name)).toEqual(['test_entity_id'])
      expect(meta.targetColumns.map((c) => c.name)).toEqual(['id'])
    })

    it('should unwrap the junction columns of a `through` relation', () => {
      const meta = service.getRelationMeta<TestTagDTO>('tags')

      expect(meta.through).toBeDefined()
      expect(meta.through?.sourceColumns.map((c) => c.name)).toEqual(['test_entity_id'])
      expect(meta.through?.targetColumns.map((c) => c.name)).toEqual(['tag_id'])
    })

    it('should cache the resolved metadata', () => {
      expect(service.getRelationMeta('testRelations')).toBe(service.getRelationMeta('testRelations'))
    })

    it('should throw a descriptive error for an unknown relation', () => {
      expect(() => service.getRelationMeta('nope')).toThrow(/Unknown relation "nope" on table "testTable"/)
    })

    it('should render a relation`s predefined `where` against the related table', () => {
      const withWhere = new DrizzleQueryService<TestEntityDTO>(stub.db, TestEntityDTO, 'testTable', relationsWithPredefinedWhere)

      expect(withWhere.getRelationMeta('namedRelations').predefinedWhere).toBeDefined()
    })

    it('should reject a predefined `where` inherited from the reverse relation', () => {
      const reversed = new DrizzleQueryService<TestRelationDTO>(
        createStubDb(relationsWithReversedPredefinedWhere).db,
        TestRelationDTO,
        'testRelationTable',
        relationsWithReversedPredefinedWhere
      )

      expect(() => reversed.getRelationMeta('testEntity')).toThrow(/inherits a predefined "where" from its reverse relation/)
    })

    it('should infer the foreign-key side from PostgreSQL FK metadata for alternate-key relations', () => {
      const parent = pgTable('alternate_parent', {
        id: serial('id').primaryKey(),
        code: text('code').notNull().unique()
      })
      const child = pgTable('alternate_child', {
        id: serial('id').primaryKey(),
        parentCode: text('parent_code').references(() => parent.code)
      })
      const relations = defineRelations({ parent, child }, (r) => ({
        parent: { children: r.many.child({ from: r.parent.code, to: r.child.parentCode }) }
      }))
      const alternateService = new DrizzleQueryService(createStubDb(relations).db, TestEntityDTO, 'parent', relations)

      expect(alternateService.getRelationMeta('children').foreignKeySide).toBe('target')
    })

    it('should allow an explicit foreign-key side for relations without database FK metadata', () => {
      const parent = pgTable('logical_parent', {
        id: serial('id').primaryKey(),
        code: text('code').notNull().unique()
      })
      const child = pgTable('logical_child', {
        id: serial('id').primaryKey(),
        parentCode: text('parent_code')
      })
      const relations = defineRelations({ parent, child }, (r) => ({
        parent: { children: r.many.child({ from: r.parent.code, to: r.child.parentCode }) }
      }))
      const logicalService = new DrizzleQueryService(createStubDb(relations).db, TestEntityDTO, 'parent', relations, {
        children: { foreignKeySide: 'target' }
      })

      expect(logicalService.getRelationMeta('children').foreignKeySide).toBe('target')
    })

    describe('primary-key inference (no declared foreign keys)', () => {
      it('should give ownership to the target when only the source side is a primary key', () => {
        const parentService = new DrizzleQueryService(
          createStubDb(inferredRelations).db,
          TestEntityDTO,
          'inferredParent',
          inferredRelations
        )

        expect(parentService.getRelationMeta('children').foreignKeySide).toBe('target')
      })

      it('should give ownership to the source when only the target side is a primary key', () => {
        const childService = new DrizzleQueryService(
          createStubDb(inferredRelations).db,
          TestEntityDTO,
          'inferredChild',
          inferredRelations
        )

        expect(childService.getRelationMeta('parent').foreignKeySide).toBe('source')
      })

      it('should report an ambiguous side when both join columns are primary keys', () => {
        const accountService = new DrizzleQueryService(
          createStubDb(ambiguousRelations).db,
          AmbiguousAccountDTO,
          'ambiguousAccount',
          ambiguousRelations
        )

        expect(accountService.getRelationMeta('profile').foreignKeySide).toBe('ambiguous')
      })
    })
  })

  describe('#queryRelations', () => {
    it('should load a relation for a single parent via a lateral join', async () => {
      stub.queueRows([[1, [relationRow(10, 1)]]])

      const result = await service.queryRelations(TestRelationDTO, 'testRelations', PARENT_A, {})

      expect(result).toEqual([relationRow(10, 1)])
      expect(stub.lastQuery().sql).toContain('left join lateral')
      expect(stub.lastQuery().sql).toContain('"d0"."id" = "d1"."test_entity_id"')
    })

    it('should apply filter, sorting and per-parent paging inside the lateral subquery', async () => {
      stub.queueRows([[1, [relationRow(10, 1)]]])

      await service.queryRelations(TestRelationDTO, 'testRelations', PARENT_A, {
        filter: { relationName: { eq: 'rel-10' } },
        sorting: [{ field: 'id', direction: SortDirection.DESC }],
        paging: { limit: 5, offset: 2 }
      })

      const { sql } = stub.lastQuery()

      // Conditions must reference the ALIASED table (d1), not "test_relation" -- otherwise the SQL is invalid.
      expect(sql).toContain('"d1"."relation_name" = $1')
      expect(sql).not.toContain('"test_relation"."relation_name"')
      expect(sql).toContain('order by "d1"."id" desc')
      // limit/offset sit inside the lateral subquery, so they apply per parent.
      expect(sql).toMatch(/limit \$\d+ offset \$\d+\) as "t"/)
    })

    it('should key the batch result map by the original parent object references', async () => {
      stub.queueRows([
        [1, [relationRow(10, 1)]],
        [2, [relationRow(20, 2)]]
      ])

      const result = await service.queryRelations(TestRelationDTO, 'testRelations', [PARENT_A, PARENT_B], {})

      expect(result.get(PARENT_A)).toEqual([relationRow(10, 1)])
      expect(result.get(PARENT_B)).toEqual([relationRow(20, 2)])
      expect(stub.lastQuery().sql).toContain('"d0"."id" in ($1, $2)')
    })

    it('should return an empty array for a parent with no rows', async () => {
      stub.queueRows([[1, [relationRow(10, 1)]]])

      const result = await service.queryRelations(TestRelationDTO, 'testRelations', [PARENT_A, PARENT_B], {})

      expect(result.get(PARENT_B)).toEqual([])
    })

    it('should join through the junction table for a many-to-many relation', async () => {
      stub.queueRows([[1, [{ id: 7, tagName: 'x' }]]])

      const result = await service.queryRelations(TestTagDTO, 'tags', PARENT_A, {})

      expect(result).toEqual([{ id: 7, tagName: 'x' }])
      expect(stub.lastQuery().sql).toContain('inner join "test_entity_tags"')
      expect(stub.lastQuery().sql).toContain('"tr0"."tag_id" = "d1"."id"')
      expect(stub.lastQuery().sql).toContain('"d0"."id" = "tr0"."test_entity_id"')
    })

    it('should not query at all for an empty parent list', async () => {
      const result = await service.queryRelations(TestRelationDTO, 'testRelations', [], {})

      expect(result.size).toBe(0)
      expect(stub.captured).toHaveLength(0)
    })
  })

  describe('#findRelation', () => {
    it('should unwrap a `one` relation returned as a single object', async () => {
      const relationService = new DrizzleQueryService<TestRelationDTO>(
        stub.db,
        TestRelationDTO,
        'testRelationTable',
        testRelations
      )
      stub.queueRows([[10, { id: 1, stringType: 'foo' }]])

      const result = await relationService.findRelation(TestEntityDTO, 'testEntity', { id: 10 } as TestRelationDTO)

      expect(result).toEqual({ id: 1, stringType: 'foo' })
    })

    it('should resolve undefined when the relation is absent', async () => {
      stub.queueRows([[1, []]])

      await expect(service.findRelation(TestRelationDTO, 'testRelations', PARENT_A)).resolves.toBeUndefined()
    })

    it('should return a map keyed by the original parents when batched', async () => {
      stub.queueRows([
        [1, [relationRow(10, 1)]],
        [2, []]
      ])

      const result = await service.findRelation(TestRelationDTO, 'testRelations', [PARENT_A, PARENT_B])

      expect(result.get(PARENT_A)).toEqual(relationRow(10, 1))
      expect(result.get(PARENT_B)).toBeUndefined()
    })
  })

  describe('#countRelations', () => {
    it('should count a non-through relation against the parent key', async () => {
      stub.queueRows([[3]])

      await expect(service.countRelations(TestRelationDTO, 'testRelations', PARENT_A, {})).resolves.toBe(3)

      const { sql, params } = stub.lastQuery()
      expect(sql).toBe('select count("id") from "test_relation" where "test_relation"."test_entity_id" = $1')
      expect(params).toEqual([1])
    })

    it('should count a through relation via the junction table', async () => {
      stub.queueRows([[2]])

      await expect(service.countRelations(TestTagDTO, 'tags', PARENT_A, {})).resolves.toBe(2)

      const { sql, params } = stub.lastQuery()
      expect(sql).toContain('inner join "test_entity_tags"')
      expect(sql).toContain('"test_entity_tags"."tag_id" = "test_tag"."id"')
      expect(sql).toContain('"test_entity_tags"."test_entity_id" = $1')
      expect(params).toEqual([1])
    })

    it('should apply an additional filter', async () => {
      stub.queueRows([[1]])

      await service.countRelations(TestRelationDTO, 'testRelations', PARENT_A, { relationName: { eq: 'rel-10' } })

      expect(stub.lastQuery().params).toEqual([1, 'rel-10'])
    })

    it('should apply the relation`s predefined `where` so the count matches what the read returns', async () => {
      const withWhere = createStubDb(relationsWithPredefinedWhere)
      const whereService = new DrizzleQueryService<TestEntityDTO>(
        withWhere.db,
        TestEntityDTO,
        'testTable',
        relationsWithPredefinedWhere
      )
      withWhere.queueRows([[3]])

      await expect(whereService.countRelations(TestRelationDTO, 'namedRelations', PARENT_A, {})).resolves.toBe(3)

      const { sql } = withWhere.lastQuery()
      expect(sql).toContain('"test_relation"."test_entity_id" = $1')
      expect(sql).toContain('"test_relation"."relation_name" is not null')
    })

    it('should combine the predefined `where` with the caller`s filter when batching parents', async () => {
      const withWhere = createStubDb(relationsWithPredefinedWhere)
      const whereService = new DrizzleQueryService<TestEntityDTO>(
        withWhere.db,
        TestEntityDTO,
        'testTable',
        relationsWithPredefinedWhere
      )
      withWhere.queueRows([[1, 3]])

      await whereService.countRelations(TestRelationDTO, 'namedRelations', [PARENT_A, PARENT_B], {
        relationName: { eq: 'rel-10' }
      })

      const { sql, params } = withWhere.lastQuery()
      expect(sql).toContain('"test_relation"."relation_name" is not null')
      expect(sql).toContain('"test_relation"."relation_name" = $3')
      expect(params).toEqual([1, 2, 'rel-10'])
    })

    it('should aggregate every parent in one query, keyed by identity', async () => {
      stub.queueRows([
        [1, 3],
        [2, 5]
      ])

      const result = await service.countRelations(TestRelationDTO, 'testRelations', [PARENT_A, PARENT_B], {})

      expect(result.get(PARENT_A)).toBe(3)
      expect(result.get(PARENT_B)).toBe(5)
      expect(stub.captured).toHaveLength(1)
      expect(stub.lastQuery().sql).toContain('where "test_relation"."test_entity_id" in ($1, $2)')
      expect(stub.lastQuery().sql).toContain('group by "test_relation"."test_entity_id"')
    })

    it('should map a missing batched row to zero', async () => {
      stub.queueRows([[1, 3]])

      const result = await service.countRelations(TestRelationDTO, 'testRelations', [PARENT_A, PARENT_B], {})

      expect(result.get(PARENT_A)).toBe(3)
      expect(result.get(PARENT_B)).toBe(0)
    })

    it('should batch through-relation counts using the junction parent key', async () => {
      stub.queueRows([
        [1, 2],
        [2, 4]
      ])

      const result = await service.countRelations(TestTagDTO, 'tags', [PARENT_A, PARENT_B], {})

      expect(result.get(PARENT_A)).toBe(2)
      expect(result.get(PARENT_B)).toBe(4)
      expect(stub.captured).toHaveLength(1)
      expect(stub.lastQuery().sql).toContain('"test_entity_tags"."test_entity_id" in ($1, $2)')
      expect(stub.lastQuery().sql).toContain('group by "test_entity_tags"."test_entity_id"')
    })

    it('should not query at all for an empty parent list', async () => {
      await expect(service.countRelations(TestRelationDTO, 'testRelations', [], {})).resolves.toEqual(new Map())

      expect(stub.captured).toHaveLength(0)
    })

    it('should resolve 0 when the relation has no rows', async () => {
      stub.queueRows([[0]])

      await expect(service.countRelations(TestRelationDTO, 'testRelations', PARENT_A, {})).resolves.toBe(0)
    })
  })

  describe('#aggregateRelations', () => {
    it('should aggregate a relation for a single parent', async () => {
      stub.queueRows([[4, 40]])

      const result = await service.aggregateRelations(
        TestRelationDTO,
        'testRelations',
        PARENT_A,
        {},
        { count: [{ field: 'id', args: {} }], max: [{ field: 'id', args: {} }] }
      )

      expect(result).toEqual([{ count: { id: 4 }, max: { id: 40 } }])
      expect(stub.lastQuery().sql).toBe(
        'select count("id"), max("id") from "test_relation" where "test_relation"."test_entity_id" = $1'
      )
    })

    it('should aggregate every parent in one query, keyed by identity', async () => {
      stub.queueRows([
        [1, 4],
        [2, 7]
      ])

      const result = await service.aggregateRelations(
        TestRelationDTO,
        'testRelations',
        [PARENT_A, PARENT_B],
        {},
        { count: [{ field: 'id', args: {} }] }
      )

      expect(result.get(PARENT_A)).toEqual([{ count: { id: 4 } }])
      expect(result.get(PARENT_B)).toEqual([{ count: { id: 7 } }])
      expect(stub.captured).toHaveLength(1)
    })

    it('should preserve the empty ungrouped aggregate result for a parent without relations', async () => {
      stub.queueRows([[1, 4, null]])

      const result = await service.aggregateRelations(
        TestRelationDTO,
        'testRelations',
        [PARENT_A, PARENT_B],
        {},
        { count: [{ field: 'id', args: {} }], max: [{ field: 'id', args: {} }] }
      )

      expect(result.get(PARENT_A)).toEqual([{ count: { id: 4 }, max: { id: null } }])
      expect(result.get(PARENT_B)).toEqual([{ count: { id: 0 }, max: { id: null } }])
    })

    it('should not query at all for an empty parent list', async () => {
      const result = await service.aggregateRelations(
        TestRelationDTO,
        'testRelations',
        [],
        {},
        {
          count: [{ field: 'id', args: {} }]
        }
      )

      expect(result).toEqual(new Map())
      expect(stub.captured).toHaveLength(0)
    })

    it('should keep requested groups separate inside each parent batch', async () => {
      stub.queueRows([
        [1, 'alpha', 2],
        [1, 'beta', 1]
      ])

      const result = await service.aggregateRelations(
        TestRelationDTO,
        'testRelations',
        [PARENT_A, PARENT_B],
        {},
        { groupBy: [{ field: 'relationName', args: {} }], count: [{ field: 'id', args: {} }] }
      )

      expect(result.get(PARENT_A)).toEqual([
        { groupBy: { relationName: 'alpha' }, count: { id: 2 } },
        { groupBy: { relationName: 'beta' }, count: { id: 1 } }
      ])
      expect(result.get(PARENT_B)).toEqual([])
      expect(stub.lastQuery().sql).toContain('group by "test_relation"."test_entity_id", "test_relation"."relation_name"')
    })
  })

  describe('relation mutations', () => {
    /** Positional parent row for `test_entity`: id, stringType, numberType, boolType, dateType. */
    const PARENT_ROW = [1, 'foo', 5, true, null]
    /** Positional related row for `test_relation`: id, relationName, testEntityId. */
    const RELATION_ROW = (id: number, testEntityId: number | null) => [id, `rel-${id}`, testEntityId]

    describe('foreign key side resolution', () => {
      it.each([
        ['testRelations', 'target'],
        ['tags', 'through']
      ])('should resolve %s to the %s side', (relationName, expected) => {
        expect(service.getRelationMeta(relationName).foreignKeySide).toBe(expected)
      })

      it('should resolve a belongs-to relation to the source side', () => {
        const relationService = new DrizzleQueryService<TestRelationDTO>(
          stub.db,
          TestRelationDTO,
          'testRelationTable',
          testRelations
        )

        expect(relationService.getRelationMeta('testEntity').foreignKeySide).toBe('source')
      })
    })

    describe('#addRelations', () => {
      it('should point the related rows at the parent when the FK is on the target', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, null), RELATION_ROW(11, null)], [])

        await service.addRelations('testRelations', 1, [10, 11])

        const { sql, params } = stub.lastQuery()
        expect(sql).toBe('update "test_relation" set "test_entity_id" = $1 where "test_relation"."id" in ($2, $3)')
        expect(params).toEqual([1, 10, 11])
      })

      it('should insert junction rows for a through relation', async () => {
        stub.queueRows([PARENT_ROW], [[7, 'tag-a']], [])

        await service.addRelations('tags', 1, [7])

        const { sql, params } = stub.lastQuery()
        expect(sql).toBe('insert into "test_entity_tags" ("test_entity_id", "tag_id") values ($1, $2) on conflict do nothing')
        expect(params).toEqual([1, 7])
      })

      it('should narrow the rows it will attach by the relation`s predefined `where`', async () => {
        const withWhere = createStubDb(relationsWithPredefinedWhere)
        const whereService = new DrizzleQueryService<TestEntityDTO>(
          withWhere.db,
          TestEntityDTO,
          'testTable',
          relationsWithPredefinedWhere
        )
        withWhere.queueRows([PARENT_ROW], [RELATION_ROW(10, null)], [])

        await whereService.addRelations('namedRelations', 1, [10])

        // A row the relation filters out must not be attachable -- it would vanish from the relation on the next
        // read, so the lookup has to fail loudly instead.
        expect(withWhere.captured[1].sql).toContain('"test_relation"."relation_name" is not null')
      })

      it('should not query or insert relation rows for an empty list', async () => {
        stub.queueRows([PARENT_ROW])

        await service.addRelations('tags', 1, [])

        expect(stub.captured).toHaveLength(1)
      })

      it('should reject a plural operation when the parent holds the foreign key', async () => {
        const relationService = new DrizzleQueryService<TestRelationDTO>(
          stub.db,
          TestRelationDTO,
          'testRelationTable',
          testRelations
        )
        stub.queueRows([RELATION_ROW(10, 1)])

        await expect(relationService.addRelations('testEntity', 10, [1])).rejects.toThrow(MethodNotAllowedException)
      })

      it('should reject when a requested relation id does not exist', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, null)])

        await expect(service.addRelations('testRelations', 1, [10, 11])).rejects.toThrow(
          'Unable to find all testRelations to add to TestEntityDTO'
        )
      })

      it('should apply the relation filter when loading the related rows', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, null)], [])

        await service.addRelations('testRelations', 1, [10], { relationFilter: { relationName: { eq: 'rel-10' } } })

        expect(stub.captured[1].sql).toContain('"test_relation"."relation_name" = $2')
        expect(stub.captured[1].params).toEqual([10, 'rel-10'])
      })
    })

    describe('#setRelation', () => {
      it('should point the parent at the related row when the FK is on the source', async () => {
        const relationService = new DrizzleQueryService<TestRelationDTO>(
          stub.db,
          TestRelationDTO,
          'testRelationTable',
          testRelations
        )
        stub.queueRows([RELATION_ROW(10, null)], [PARENT_ROW], [])

        await relationService.setRelation('testEntity', 10, 1)

        const { sql, params } = stub.lastQuery()
        expect(sql).toBe('update "test_relation" set "test_entity_id" = $1 where "test_relation"."id" = $2')
        expect(params).toEqual([1, 10])
      })

      it('should detach the previous holder before attaching when the FK is on the target', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, null)], [], [])

        await service.setRelation('testRelations', 1, 10)

        // detach everything currently pointing at the parent, then point the new row at it
        expect(stub.captured[2].sql).toBe(
          'update "test_relation" set "test_entity_id" = $1 where "test_relation"."test_entity_id" = $2'
        )
        expect(stub.captured[2].params).toEqual([null, 1])
        expect(stub.captured[3].sql).toContain('where "test_relation"."id" in ($2)')
      })

      it('should clear the junction table before inserting for a through relation', async () => {
        stub.queueRows([PARENT_ROW], [[7, 'tag-a']], [], [])

        await service.setRelation('tags', 1, 7)

        expect(stub.captured[2].sql).toBe('delete from "test_entity_tags" where "test_entity_tags"."test_entity_id" = $1')
        expect(stub.captured[2].params).toEqual([1])
        expect(stub.captured[3].sql).toContain('insert into "test_entity_tags"')
        expect(stub.captured[3].params).toEqual([1, 7])
      })
    })

    describe('#removeRelation', () => {
      it('should clear the parent foreign key when it lives on the source', async () => {
        const relationService = new DrizzleQueryService<TestRelationDTO>(
          stub.db,
          TestRelationDTO,
          'testRelationTable',
          testRelations
        )
        stub.queueRows([RELATION_ROW(10, 1)], [PARENT_ROW], [])

        await relationService.removeRelation('testEntity', 10, 1)

        expect(stub.lastQuery().params).toEqual([null, 10])
      })

      it('should only detach a target row that actually points at this parent', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, 1)], [])

        await service.removeRelation('testRelations', 1, 10)

        const { sql, params } = stub.lastQuery()
        expect(sql).toContain('"test_relation"."id" in ($2)')
        expect(sql).toContain('"test_relation"."test_entity_id" = $3')
        expect(params).toEqual([null, 10, 1])
      })

      it('should delete only the matching junction row', async () => {
        stub.queueRows([PARENT_ROW], [[7, 'tag-a']], [])

        await service.removeRelation('tags', 1, 7)

        const { sql, params } = stub.lastQuery()
        expect(sql).toBe(
          'delete from "test_entity_tags" where (("test_entity_tags"."test_entity_id" = $1) and ("test_entity_tags"."tag_id" = $2))'
        )
        expect(params).toEqual([1, 7])
      })
    })

    describe('#setRelations', () => {
      it('should narrow the detach to the relation`s predefined `where` when replacing the collection', async () => {
        const withWhere = createStubDb(relationsWithPredefinedWhere)
        const whereService = new DrizzleQueryService<TestEntityDTO>(
          withWhere.db,
          TestEntityDTO,
          'testTable',
          relationsWithPredefinedWhere
        )
        withWhere.queueRows([PARENT_ROW], [RELATION_ROW(10, null)], [], [])

        await whereService.setRelations('namedRelations', 1, [10])

        // The detach must not reach rows outside the relation -- clearing their foreign key would silently mutate
        // data the relation never contained.
        const detach = withWhere.captured[2]
        expect(detach.sql).toContain('update "test_relation" set "test_entity_id" = $1')
        expect(detach.sql).toContain('"test_relation"."relation_name" is not null')
      })

      it('should detach the whole collection before attaching the new one', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, null)], [], [])

        await service.setRelations('testRelations', 1, [10])

        expect(stub.captured[2].sql).toBe(
          'update "test_relation" set "test_entity_id" = $1 where "test_relation"."test_entity_id" = $2'
        )
        expect(stub.captured[3].sql).toContain('"test_relation"."id" in ($2)')
      })

      it('should detach everything and attach nothing for an empty list', async () => {
        stub.queueRows([PARENT_ROW], [])

        await service.setRelations('testRelations', 1, [])

        // getById + a single detach, with no lookup of related rows and no re-attach
        expect(stub.captured).toHaveLength(2)
        expect(stub.captured[1].params).toEqual([null, 1])
      })

      it('should clear the junction table before inserting for a through relation', async () => {
        stub.queueRows([PARENT_ROW], [[7, 'tag-a']], [], [])

        await service.setRelations('tags', 1, [7])

        expect(stub.captured[2].sql).toBe('delete from "test_entity_tags" where "test_entity_tags"."test_entity_id" = $1')
        expect(stub.captured[3].sql).toContain('insert into "test_entity_tags"')
      })
    })

    describe('#removeRelations', () => {
      it('should detach the given target rows only', async () => {
        stub.queueRows([PARENT_ROW], [RELATION_ROW(10, 1), RELATION_ROW(11, 1)], [])

        await service.removeRelations('testRelations', 1, [10, 11])

        expect(stub.lastQuery().params).toEqual([null, 10, 11, 1])
      })

      it('should delete the given junction rows only', async () => {
        stub.queueRows(
          [PARENT_ROW],
          [
            [7, 'tag-a'],
            [8, 'tag-b']
          ],
          []
        )

        await service.removeRelations('tags', 1, [7, 8])

        const { sql, params } = stub.lastQuery()
        expect(sql).toContain('delete from "test_entity_tags"')
        expect(sql).toContain('"test_entity_tags"."test_entity_id" = $1')
        expect(params).toEqual([1, 7, 8])
      })

      it('should not query or delete relation rows for an empty list', async () => {
        stub.queueRows([PARENT_ROW])

        await service.removeRelations('tags', 1, [])

        expect(stub.captured).toHaveLength(1)
      })
    })

    describe('ambiguous relations', () => {
      let ambiguousStub: StubDb
      let ambiguousService: DrizzleQueryService<AmbiguousAccountDTO>

      beforeEach(() => {
        ambiguousStub = createStubDb(ambiguousRelations)
        ambiguousService = new DrizzleQueryService<AmbiguousAccountDTO>(
          ambiguousStub.db,
          AmbiguousAccountDTO,
          'ambiguousAccount',
          ambiguousRelations
        )
      })

      it.each([['addRelations'], ['setRelations'], ['removeRelations']] as const)(
        'should reject %s when neither side owns the foreign key',
        async (method) => {
          ambiguousStub.queueRows([AMBIGUOUS_ACCOUNT_ROW])

          const error = await ambiguousService[method]('profile', 1, [1]).catch((thrown: Error) => thrown)

          expect(error).toBeInstanceOf(MethodNotAllowedException)
          expect((error as Error).message).toMatch(/ambiguous/)
        }
      )

      it.each([['setRelation'], ['removeRelation']] as const)(
        'should reject %s when neither side owns the foreign key',
        async (method) => {
          ambiguousStub.queueRows([AMBIGUOUS_ACCOUNT_ROW], [AMBIGUOUS_PROFILE_ROW])

          const error = await ambiguousService[method]('profile', 1, 1).catch((thrown: Error) => thrown)

          expect(error).toBeInstanceOf(MethodNotAllowedException)
          expect((error as Error).message).toMatch(/ambiguous/)
        }
      )

      it('should still allow reading an ambiguous relation', async () => {
        ambiguousStub.queueRows([[4]])

        const count = await ambiguousService.countRelations(AmbiguousAccountDTO, 'profile', { id: 1 } as AmbiguousAccountDTO, {})

        expect(count).toBe(4)
        expect(ambiguousStub.lastQuery().sql).toBe(
          'select count("id") from "ambiguous_profile" where "ambiguous_profile"."id" = $1'
        )
      })
    })
  })

  describe('composite join keys', () => {
    const COMPOSITE_A: CompositeParentDTO = { id: 1, tenantId: 7, groupId: 1 } as CompositeParentDTO
    const COMPOSITE_B: CompositeParentDTO = { id: 2, tenantId: 7, groupId: 2 } as CompositeParentDTO

    let compositeStub: StubDb
    let compositeService: DrizzleQueryService<CompositeParentDTO>

    beforeEach(() => {
      compositeStub = createStubDb(compositeKeyRelations)
      compositeService = new DrizzleQueryService<CompositeParentDTO>(
        compositeStub.db,
        CompositeParentDTO,
        'compositeParent',
        compositeKeyRelations
      )
    })

    it('should batch counts with an OR of ANDs instead of a single IN', async () => {
      compositeStub.queueRows([
        [7, 1, 3],
        [7, 2, 5]
      ])

      const result = await compositeService.countRelations(CompositeChildDTO, 'children', [COMPOSITE_A, COMPOSITE_B], {})

      expect(result.get(COMPOSITE_A)).toBe(3)
      expect(result.get(COMPOSITE_B)).toBe(5)
      expect(compositeStub.captured).toHaveLength(1)

      const { sql, params } = compositeStub.lastQuery()
      expect(sql).toContain('"composite_child"."tenant_id" = $1')
      expect(sql).toContain('"composite_child"."group_id" = $2')
      expect(sql).toContain(') or (')
      expect(sql).toContain('group by "composite_child"."tenant_id", "composite_child"."group_id"')
      // Both key columns of both parents, in order -- not flattened into one IN list.
      expect(params).toEqual([7, 1, 7, 2])
    })

    it('should not confuse two parents that share only one of the two key columns', async () => {
      compositeStub.queueRows([[7, 2, 5]])

      const result = await compositeService.countRelations(CompositeChildDTO, 'children', [COMPOSITE_A, COMPOSITE_B], {})

      expect(result.get(COMPOSITE_A)).toBe(0)
      expect(result.get(COMPOSITE_B)).toBe(5)
    })

    it('should batch aggregates on a composite key', async () => {
      compositeStub.queueRows([
        [7, 1, 2, 11],
        [7, 2, 1, 22]
      ])

      const result = await compositeService.aggregateRelations(
        CompositeChildDTO,
        'children',
        [COMPOSITE_A, COMPOSITE_B],
        {},
        { count: [{ field: 'id', args: {} }], max: [{ field: 'id', args: {} }] }
      )

      expect(result.get(COMPOSITE_A)).toEqual([{ count: { id: 2 }, max: { id: 11 } }])
      expect(result.get(COMPOSITE_B)).toEqual([{ count: { id: 1 }, max: { id: 22 } }])
      expect(compositeStub.captured).toHaveLength(1)
    })
  })
})
