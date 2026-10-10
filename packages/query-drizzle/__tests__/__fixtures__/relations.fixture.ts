import { defineRelations } from 'drizzle-orm'
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core'

import { testEntityTags, testRelationTable, testTable, testTagTable } from './test-table'

export const testRelations = defineRelations({ testTable, testRelationTable, testTagTable, testEntityTags }, (r) => ({
  testTable: {
    // many: FK lives on the related table
    testRelations: r.many.testRelationTable({
      from: r.testTable.id,
      to: r.testRelationTable.testEntityId
    }),
    // many-to-many through a junction table
    tags: r.many.testTagTable({
      from: r.testTable.id.through(r.testEntityTags.testEntityId),
      to: r.testTagTable.id.through(r.testEntityTags.tagId)
    })
  },
  testRelationTable: {
    // one: FK lives on the declaring table
    testEntity: r.one.testTable({
      from: r.testRelationTable.testEntityId,
      to: r.testTable.id
    })
  }
}))

/**
 * Tables deliberately declared **without** `.references()`, so `hasForeignKey` finds nothing on either side and
 * `resolveForeignKeySide` has to fall back to primary-key inference. `testRelations` above declares its foreign
 * keys, which short-circuits that fallback -- without this config the inference path would never run.
 */
export const inferredParent = pgTable('inferred_parent', {
  id: serial('id').primaryKey(),
  name: text('name').notNull()
})

export const inferredChild = pgTable('inferred_child', {
  id: serial('id').primaryKey(),
  parentId: integer('parent_id')
})

export const inferredRelations = defineRelations({ inferredParent, inferredChild }, (r) => ({
  inferredParent: {
    // source is the parent's primary key, target is not a key -> the child owns the foreign key
    children: r.many.inferredChild({ from: r.inferredParent.id, to: r.inferredChild.parentId })
  },
  inferredChild: {
    // the mirror image: source is not a key, target is -> the child (this table) owns the foreign key
    parent: r.one.inferredParent({ from: r.inferredChild.parentId, to: r.inferredParent.id })
  }
}))

/**
 * Shared-primary-key one-to-one. Neither side declares a foreign key and *both* join columns are primary keys, so
 * ownership genuinely cannot be inferred -- this is the `'ambiguous'` case that `relationOptions.foreignKeySide`
 * exists to resolve.
 */
export const ambiguousAccount = pgTable('ambiguous_account', {
  id: serial('id').primaryKey(),
  name: text('name').notNull()
})

export const ambiguousProfile = pgTable('ambiguous_profile', {
  id: integer('id').primaryKey(),
  bio: text('bio')
})

export const ambiguousRelations = defineRelations({ ambiguousAccount, ambiguousProfile }, (r) => ({
  ambiguousAccount: {
    profile: r.one.ambiguousProfile({ from: r.ambiguousAccount.id, to: r.ambiguousProfile.id })
  }
}))

export class AmbiguousAccountDTO {
  id!: number

  name!: string
}

/** Positional row for `ambiguous_account`: id, name. */
export const AMBIGUOUS_ACCOUNT_ROW = [1, 'acme']

/** Positional row for `ambiguous_profile`: id, bio. */
export const AMBIGUOUS_PROFILE_ROW = [1, 'bio']

/**
 * A relation joined on two columns. Composite join keys take a different branch when batching relation aggregates
 * (an OR of ANDs instead of a single `IN`), which single-column relations never reach.
 */
export const compositeParent = pgTable('composite_parent', {
  id: serial('id').primaryKey(),
  tenantId: integer('tenant_id').notNull(),
  groupId: integer('group_id').notNull()
})

export const compositeChild = pgTable('composite_child', {
  id: serial('id').primaryKey(),
  tenantId: integer('tenant_id').notNull(),
  groupId: integer('group_id').notNull()
})

export const compositeKeyRelations = defineRelations({ compositeParent, compositeChild }, (r) => ({
  compositeParent: {
    children: r.many.compositeChild({
      from: [r.compositeParent.tenantId, r.compositeParent.groupId],
      to: [r.compositeChild.tenantId, r.compositeChild.groupId]
    })
  }
}))

export class CompositeParentDTO {
  id!: number

  tenantId!: number

  groupId!: number
}

export class CompositeChildDTO {
  id!: number

  tenantId!: number

  groupId!: number
}

/**
 * A separate config whose relation declares a predefined `where`. Drizzle applies it inside its relational query
 * builder; the adapter has to reproduce it on the hand-built aggregate and mutation queries.
 */
export const relationsWithPredefinedWhere = defineRelations({ testTable, testRelationTable }, (r) => ({
  testTable: {
    namedRelations: r.many.testRelationTable({
      from: r.testTable.id,
      to: r.testRelationTable.testEntityId,
      where: { relationName: { isNotNull: true } }
    })
  }
}))

/**
 * The reverse of {@link relationsWithPredefinedWhere}: `testEntity` declares neither `from` nor `to`, so Drizzle
 * infers both its join keys *and* its `where` from `namedRelations` -- and that filter stays scoped to
 * `test_relation`, the declaring table of the relation it was inherited from. The adapter's aggregate queries
 * select from the related table alone, so this one still has to be rejected.
 */
export const relationsWithReversedPredefinedWhere = defineRelations({ testTable, testRelationTable }, (r) => ({
  testTable: {
    namedRelations: r.many.testRelationTable({
      from: r.testTable.id,
      to: r.testRelationTable.testEntityId,
      where: { relationName: { isNotNull: true } }
    })
  },
  testRelationTable: {
    testEntity: r.one.testTable()
  }
}))

/**
 * A relation whose target *is* its source table. Without aliasing the subquery the correlation would compare a
 * column with itself and match every row, so this is the fixture that proves the alias is load-bearing.
 */
export const selfRefNode = pgTable('node', {
  id: serial('id').primaryKey(),
  parentId: integer('parent_id'),
  name: text('name').notNull()
})

export const selfReferencingRelations = defineRelations({ selfRefNode }, (r) => ({
  selfRefNode: {
    children: r.many.selfRefNode({ from: r.selfRefNode.id, to: r.selfRefNode.parentId })
  }
}))

export class SelfRefNodeDTO {
  id!: number

  parentId?: number

  name!: string
}
