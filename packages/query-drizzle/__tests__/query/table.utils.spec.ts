import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

import { TableMeta } from '../../src/query'

class TableLevelPrimaryKeyDTO {
  id!: number
}

describe('TableMeta', () => {
  it('should resolve a single-column table-level primary key', () => {
    const table = pgTable('table_level_pk', { id: integer('id') }, (t) => [primaryKey({ columns: [t.id] })])
    const meta = new TableMeta<TableLevelPrimaryKeyDTO>(table, 'tableLevelPk')

    expect(meta.primaryKey.field).toBe('id')
    expect(meta.primaryKey.column).toBe(table.id)
    expect(meta.isPrimaryKeyColumn(table.id)).toBe(true)
  })

  it('should report every field in a table-level composite primary key', () => {
    const table = pgTable('composite_pk', { tenantId: integer('tenant_id'), slug: text('slug') }, (t) => [
      primaryKey({ columns: [t.tenantId, t.slug] })
    ])

    expect(() => new TableMeta(table, 'compositePk')).toThrow(/composite primary key \(tenantId, slug\)/)
  })
})
