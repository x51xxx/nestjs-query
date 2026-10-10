import { getColumns, relationsFilterToSQL } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'

import type { Relation, RelationsRecord, SQL, TableRelationalConfig, TablesRelationalConfig } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import { isEmptyRelationsFilter, isRelationFilterReversed } from './drizzle-compat.utils'
import { hasOwn, TableMeta } from './table.utils'

/** A `RelationsBuilderColumn` wrapper -- Drizzle stores `through` keys wrapped, with the column at `._.column`. */
interface WrappedColumn {
  _: { column: PgColumn }
}

const unwrap = (column: WrappedColumn | PgColumn): PgColumn => (column as WrappedColumn)._?.column ?? (column as PgColumn)

/**
 * Reverse lookup of a column's JS property name on an arbitrary table. Junction tables often have no primary key,
 * so they cannot go through {@link TableMeta}.
 */
const fieldNameOf = (table: PgTable, column: PgColumn): string => {
  const entry = Object.entries(getColumns(table) as Record<string, PgColumn>).find(([, candidate]) => candidate === column)

  if (!entry) {
    throw new Error(`Column "${column.name}" does not belong to the junction table`)
  }

  return entry[0]
}

const sameColumns = (left: PgColumn[], right: PgColumn[]): boolean =>
  left.length === right.length && left.every((column, index) => column === right[index])

const hasForeignKey = (table: PgTable, columns: PgColumn[], foreignTable: PgTable, foreignColumns: PgColumn[]): boolean =>
  getTableConfig(table).foreignKeys.some((foreignKey) => {
    const reference = foreignKey.reference()

    return (
      reference.foreignTable === foreignTable &&
      sameColumns(reference.columns, columns) &&
      sameColumns(reference.foreignColumns, foreignColumns)
    )
  })

export interface ThroughMeta {
  table: PgTable
  /** Junction columns pairing with `RelationMeta.sourceColumns`, positionally. */
  sourceColumns: PgColumn[]
  /** Junction columns pairing with `RelationMeta.targetColumns`, positionally. */
  targetColumns: PgColumn[]
  /** JS property names of {@link sourceColumns}, for building insert values. */
  sourceFields: string[]
  /** JS property names of {@link targetColumns}, for building insert values. */
  targetFields: string[]
}

/**
 * Which side physically stores the foreign key.
 *
 * `relationType` cannot answer this -- a `one` relation may be belongs-to (FK on the declaring table) or has-one
 * (FK on the related table). The side whose columns are not its own primary key is the one holding the FK;
 * `ambiguous` covers shared-primary-key one-to-one, where mutation has no well-defined meaning.
 */
export type ForeignKeySide = 'source' | 'target' | 'through' | 'ambiguous'

/**
 * @internal
 * Runtime metadata for one relation declared via `defineRelations()`.
 *
 * Drizzle normalizes relation metadata: `sourceColumns` always belong to the declaring table and `targetColumns`
 * always belong to the related table, for `one`, `many` and reverse-inferred relations alike. There is therefore no
 * direction branching -- the join is uniformly `sourceColumns[i] == targetColumns[i]`, optionally hopping through a
 * junction table.
 */
export class RelationMeta<Entity, RelationDTO> {
  readonly isMany: boolean

  readonly targetMeta: TableMeta<RelationDTO>

  /** Columns on the declaring table. */
  readonly sourceColumns: PgColumn[]

  /** Columns on the related table, positionally paired with {@link sourceColumns}. */
  readonly targetColumns: PgColumn[]

  readonly through?: ThroughMeta

  readonly foreignKeySide: ForeignKeySide

  /**
   * The relation's own `where`, pre-rendered against the target table.
   *
   * Drizzle applies this inside its relational query builder, so the read path gets it for free. The aggregate and
   * mutation paths build SQL by hand and have to add it explicitly, or `queryRelations` and `countRelations` would
   * disagree about which rows belong to the relation.
   */
  readonly predefinedWhere?: SQL

  /** Retained so the filter can be re-rendered against an aliased target -- see {@link predefinedWhereOn}. */
  private readonly predefinedWhereFilter?: unknown

  private readonly targetRelations?: RelationsRecord

  private readonly allRelations: TablesRelationalConfig

  constructor(
    readonly sourceMeta: TableMeta<Entity>,
    readonly relationName: string,
    sourceTableConfig: TableRelationalConfig,
    relations: TablesRelationalConfig,
    foreignKeySide?: Extract<ForeignKeySide, 'source' | 'target'>
  ) {
    const relation = hasOwn(sourceTableConfig.relations, relationName)
      ? (sourceTableConfig.relations[relationName] as Relation)
      : undefined

    if (!relation) {
      const available = Object.keys(sourceTableConfig.relations)

      throw new Error(
        `Unknown relation "${relationName}" on table "${sourceMeta.tableName}".` +
          (available.length ? ` Available relations: ${available.join(', ')}` : ' It has no relations defined.')
      )
    }

    const targetTableConfig = relations[relation.targetTableName]
    if (!targetTableConfig) {
      throw new Error(`Relation "${relationName}" targets unknown table "${relation.targetTableName}".`)
    }

    if (!isEmptyRelationsFilter(relation.where)) {
      // A relation that declares neither `from` nor `to` inherits both its join keys and its `where` from the
      // reverse relation, and that filter stays scoped to *this* table rather than the related one. The hand-built
      // aggregate queries select from the related table alone, so such a filter has nothing to bind to.
      if (isRelationFilterReversed(relation)) {
        throw new Error(
          `Relation "${relationName}" on table "${sourceMeta.tableName}" inherits a predefined "where" from its ` +
            'reverse relation, which is scoped to the declaring table and cannot be applied to aggregates. ' +
            'Declare "from"/"to" explicitly on this side to give it its own filter.'
        )
      }

      this.predefinedWhereFilter = relation.where
      this.targetRelations = targetTableConfig.relations
      this.predefinedWhere = relationsFilterToSQL(targetTableConfig.table, relation.where, targetTableConfig.relations, relations)
    }

    this.allRelations = relations

    this.isMany = relation.relationType === 'many'
    this.targetMeta = new TableMeta<RelationDTO>(targetTableConfig.table, relation.targetTableName)
    this.sourceColumns = relation.sourceColumns as PgColumn[]
    this.targetColumns = relation.targetColumns as PgColumn[]

    if (relation.throughTable && relation.through) {
      const table = relation.throughTable as PgTable
      const sourceColumns = relation.through.source.map((column) => unwrap(column as unknown as WrappedColumn))
      const targetColumns = relation.through.target.map((column) => unwrap(column as unknown as WrappedColumn))

      this.through = {
        table,
        sourceColumns,
        targetColumns,
        sourceFields: sourceColumns.map((column) => fieldNameOf(table, column)),
        targetFields: targetColumns.map((column) => fieldNameOf(table, column))
      }
    }

    this.assertKeysAreZippable()
    this.foreignKeySide = this.resolveForeignKeySide(foreignKeySide)
  }

  /**
   * Reads the join key values off a parent entity, in `sourceColumns` order. Rows are keyed by JS property name,
   * so each column is reverse-looked-up on the source table first.
   */
  public sourceKeyOf(entity: Entity): unknown[] {
    return this.sourceColumns.map((column) => (entity as Record<string, unknown>)[this.sourceMeta.fieldFor(column)])
  }

  /** JS property names of {@link targetColumns}, for reading join keys off related rows. */
  public get targetFields(): string[] {
    return this.targetColumns.map((column) => this.targetMeta.fieldFor(column))
  }

  /** JS property names of {@link sourceColumns}, for reading join keys off the parent. */
  public get sourceFields(): string[] {
    return this.sourceColumns.map((column) => this.sourceMeta.fieldFor(column))
  }

  /**
   * {@link predefinedWhere} re-rendered against a specific table reference.
   *
   * The cached `predefinedWhere` names the target table directly, which is only valid where the query selects from
   * it unaliased. Inside an `EXISTS` subquery the target is aliased, and a filter naming the real table would
   * either be invalid SQL or -- worse -- silently correlate to an outer occurrence of the same table.
   */
  public predefinedWhereOn(table: PgTable): SQL | undefined {
    // The relation config is passed through even though Drizzle types a relation's `where` as `TableFilter` --
    // columns only, no relation keys -- so the branch that would consume it (and the `depth` used to alias its
    // nested subqueries) is unreachable from the public API.

    if (this.predefinedWhereFilter === undefined) {
      return undefined
    }

    return relationsFilterToSQL(
      table as never,
      this.predefinedWhereFilter as never,
      this.targetRelations as never,
      this.allRelations
    )
  }

  private resolveForeignKeySide(override?: Extract<ForeignKeySide, 'source' | 'target'>): ForeignKeySide {
    if (this.through) {
      return 'through'
    }

    if (override) {
      return override
    }

    const sourceHasForeignKey = hasForeignKey(
      this.sourceMeta.table,
      this.sourceColumns,
      this.targetMeta.table,
      this.targetColumns
    )
    const targetHasForeignKey = hasForeignKey(
      this.targetMeta.table,
      this.targetColumns,
      this.sourceMeta.table,
      this.sourceColumns
    )

    if (sourceHasForeignKey !== targetHasForeignKey) {
      return sourceHasForeignKey ? 'source' : 'target'
    }

    const sourceIsKey = this.sourceColumns.every((column) => this.sourceMeta.isPrimaryKeyColumn(column))
    const targetIsKey = this.targetColumns.every((column) => this.targetMeta.isPrimaryKeyColumn(column))

    if (sourceIsKey && !targetIsKey) {
      return 'target'
    }
    if (targetIsKey && !sourceIsKey) {
      return 'source'
    }

    return 'ambiguous'
  }

  /** Composite keys are legal, so every key list must line up positionally. */
  private assertKeysAreZippable(): void {
    if (this.sourceColumns.length !== this.targetColumns.length) {
      throw new Error(
        `Relation "${this.relationName}" on table "${this.sourceMeta.tableName}" has mismatched key lengths ` +
          `(${this.sourceColumns.length} source vs ${this.targetColumns.length} target).`
      )
    }

    if (
      this.through &&
      (this.through.sourceColumns.length !== this.sourceColumns.length ||
        this.through.targetColumns.length !== this.targetColumns.length)
    ) {
      throw new Error(
        `Relation "${this.relationName}" on table "${this.sourceMeta.tableName}" has mismatched junction key lengths.`
      )
    }
  }
}
