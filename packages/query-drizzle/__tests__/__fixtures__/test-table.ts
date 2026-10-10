import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const testTable = pgTable('test_entity', {
  id: serial('id').primaryKey(),
  stringType: text('string_type').notNull(),
  numberType: integer('number_type'),
  boolType: boolean('bool_type'),
  dateType: timestamp('date_type')
})

/** Related table with a foreign key back to `test_entity` -- exercises `one` and `many` relations. */
export const testRelationTable = pgTable('test_relation', {
  id: serial('id').primaryKey(),
  relationName: text('relation_name').notNull(),
  testEntityId: integer('test_entity_id').references(() => testTable.id)
})

/** Third table reached only through a junction -- exercises `through()` many-to-many. */
export const testTagTable = pgTable('test_tag', {
  id: serial('id').primaryKey(),
  tagName: text('tag_name').notNull()
})

export const testEntityTags = pgTable('test_entity_tags', {
  testEntityId: integer('test_entity_id')
    .notNull()
    .references(() => testTable.id),
  tagId: integer('tag_id')
    .notNull()
    .references(() => testTagTable.id)
})

/** Column order matters for the stub driver -- rows come back positionally. */
export const TEST_TABLE_COLUMN_ORDER = ['id', 'stringType', 'numberType', 'boolType', 'dateType'] as const

export class TestEntityDTO {
  id!: number

  stringType!: string

  numberType!: number

  boolType!: boolean

  dateType!: Date
}

export class TestRelationDTO {
  id!: number

  relationName!: string

  testEntityId!: number
}

export class TestTagDTO {
  id!: number

  tagName!: string
}
