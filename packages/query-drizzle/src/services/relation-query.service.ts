import { MethodNotAllowedException } from '@nestjs/common'
import {
  AggregateQuery,
  AggregateResponse,
  Class,
  Filter,
  FindRelationOptions,
  GetByIdOptions,
  ModifyRelationOptions,
  Query,
  QueryRelationsOptions
} from '@ptc-org/nestjs-query-core'
import { and, eq, inArray, or, SQL } from 'drizzle-orm'

import type { TableRelationalConfig, TablesRelationalConfig } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { AggregateBuilder, FilterQueryBuilder, hasOwn, RelationMeta, TableMeta } from '../query'
import { toDrizzleRelationsFilter } from '../query/drizzle-compat.utils'
import { DrizzleDatabase, NestjsQueryDrizzleRelationOptions } from '../typings'

const BATCH_KEY_ALIAS = '__nestjs_query_parent_key_'

const relationKey = (values: unknown[]): string =>
  values
    .map((value) => {
      const normalized = value instanceof Date ? value.toISOString() : String(value)

      return `${typeof value}:${normalized.length}:${normalized}`
    })
    .join('|')

/**
 * Houses relation loading for the Drizzle adapter.
 *
 * Reads are split across two strategies, because neither covers both cases well:
 *
 * - `queryRelations` / `findRelation` go through Drizzle's relational query builder (`db.query.<table>.findMany`),
 *   which emits a `left join lateral`. That applies limit/offset **per parent**, which is what a GraphQL
 *   connection needs, and it resolves `through` junction tables automatically. Note this is deliberately more
 *   correct than `query-typeorm`, whose `batchSelect` applies paging globally across all parents.
 * - `countRelations` / `aggregateRelations` build grouped SQL directly, since the relational query builder is
 *   row-shaped and cannot express aggregates. Array overloads include the relation join key in the grouping so a
 *   dataloader batch remains one SQL query instead of degrading to N queries.
 *
 * Mutations resolve which side physically holds the foreign key (see `RelationMeta.foreignKeySide`) and update
 * that side: the parent row for belongs-to, the related rows for has-one/has-many, or the junction table for
 * `through` relations. Plural operations are rejected when the parent itself holds the key, since such a relation
 * holds a single value. Mutations are **not** wrapped in a transaction -- `setRelations` performs a detach followed
 * by an attach, so a failure in between can leave the collection empty.
 *
 * `RelationClass` and `opts.lookedAhead` are accepted for interface compatibility but have no effect: rows are
 * returned as plain objects without assembler conversion (see `DrizzleQueryService`), and `query()` never eager
 * loads relations, so a looked-ahead value is never present on the parent.
 *
 * @internal
 */
export abstract class RelationQueryService<Entity> {
  abstract db: DrizzleDatabase

  abstract EntityClass: Class<Entity>

  abstract tableConfig: TableRelationalConfig

  abstract relations: TablesRelationalConfig

  abstract relationOptions: Record<string, NestjsQueryDrizzleRelationOptions>

  abstract tableMeta: TableMeta<Entity>

  abstract getById(id: string | number, opts?: GetByIdOptions<Entity>): Promise<Entity>

  private readonly relationMetaCache = new Map<string, RelationMeta<Entity, unknown>>()

  private readonly targetFilterQueryBuilders = new Map<string, FilterQueryBuilder<unknown>>()

  public async queryRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    entities: Entity[],
    query: Query<Relation>,
    opts?: QueryRelationsOptions
  ): Promise<Map<Entity, Relation[]>>

  public async queryRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    query: Query<Relation>,
    opts?: QueryRelationsOptions
  ): Promise<Relation[]>

  public async queryRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    query: Query<Relation>
  ): Promise<Relation[] | Map<Entity, Relation[]>> {
    const entities = Array.isArray(dto) ? dto : [dto]
    const loaded = await this.loadRelations<Relation>(relationName, entities, query)

    return Array.isArray(dto) ? loaded : (loaded.get(dto) ?? [])
  }

  public async findRelation<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dtos: Entity[],
    opts?: FindRelationOptions<Relation>
  ): Promise<Map<Entity, Relation | undefined>>

  public async findRelation<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    opts?: FindRelationOptions<Relation>
  ): Promise<Relation | undefined>

  public async findRelation<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    opts?: FindRelationOptions<Relation>
  ): Promise<(Relation | undefined) | Map<Entity, Relation | undefined>> {
    const entities = Array.isArray(dto) ? dto : [dto]
    const loaded = await this.loadRelations<Relation>(relationName, entities, {
      filter: opts?.filter,
      paging: { limit: 1 }
    })

    if (!Array.isArray(dto)) {
      return loaded.get(dto)?.[0]
    }

    const results = new Map<Entity, Relation | undefined>()
    entities.forEach((entity) => results.set(entity, loaded.get(entity)?.[0]))

    return results
  }

  public async countRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    entities: Entity[],
    filter: Filter<Relation>,
    opts?: QueryRelationsOptions
  ): Promise<Map<Entity, number>>

  public async countRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    filter: Filter<Relation>,
    opts?: QueryRelationsOptions
  ): Promise<number>

  public async countRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    filter: Filter<Relation>
  ): Promise<number | Map<Entity, number>> {
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const aggregateBuilder = new AggregateBuilder<Relation>(relationMeta.targetMeta)
    const { selection, groupBy, convert } = aggregateBuilder.build({
      count: [{ field: relationMeta.targetMeta.primaryKey.field as keyof Relation, args: {} }]
    })

    const countFor = async (entity: Entity): Promise<number> => {
      const rows = (await this.relationSelect(relationMeta, entity, selection, filter)) as Record<string, unknown>[]

      return convert(rows)[0]?.count?.[relationMeta.targetMeta.primaryKey.field as keyof Relation] ?? 0
    }

    if (!Array.isArray(dto)) {
      return countFor(dto)
    }

    if (!dto.length) {
      return new Map<Entity, number>()
    }

    const { rows, keyAliases } = await this.relationAggregateSelectMany(relationMeta, dto, selection, filter, groupBy)
    const counts = new Map<string, number>()

    for (const row of rows) {
      const key = relationKey(keyAliases.map((alias) => row[alias]))
      const response = convert([row])[0]
      counts.set(key, response?.count?.[relationMeta.targetMeta.primaryKey.field as keyof Relation] ?? 0)
    }

    return dto.reduce(
      (results, entity) => results.set(entity, counts.get(relationKey(relationMeta.sourceKeyOf(entity))) ?? 0),
      new Map<Entity, number>()
    )
  }

  public async aggregateRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    entities: Entity[],
    filter: Filter<Relation>,
    aggregate: AggregateQuery<Relation>
  ): Promise<Map<Entity, AggregateResponse<Relation>[]>>

  public async aggregateRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity,
    filter: Filter<Relation>,
    aggregate: AggregateQuery<Relation>
  ): Promise<AggregateResponse<Relation>[]>

  public async aggregateRelations<Relation>(
    RelationClass: Class<Relation>,
    relationName: string,
    dto: Entity | Entity[],
    filter: Filter<Relation>,
    aggregate: AggregateQuery<Relation>
  ): Promise<AggregateResponse<Relation>[] | Map<Entity, AggregateResponse<Relation>[]>> {
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const { selection, groupBy, convert, empty } = new AggregateBuilder<Relation>(relationMeta.targetMeta).build(aggregate)

    const aggregateFor = async (entity: Entity): Promise<AggregateResponse<Relation>[]> => {
      const rows = (await this.relationSelect(relationMeta, entity, selection, filter, groupBy)) as Record<string, unknown>[]

      return convert(rows)
    }

    if (!Array.isArray(dto)) {
      return aggregateFor(dto)
    }

    if (!dto.length) {
      return new Map<Entity, AggregateResponse<Relation>[]>()
    }

    const { rows, keyAliases } = await this.relationAggregateSelectMany(relationMeta, dto, selection, filter, groupBy)
    const aggregates = new Map<string, AggregateResponse<Relation>[]>()

    for (const row of rows) {
      const key = relationKey(keyAliases.map((alias) => row[alias]))
      const values = aggregates.get(key) ?? []
      values.push(...convert([row]))
      aggregates.set(key, values)
    }

    return dto.reduce(
      (results, entity) => results.set(entity, aggregates.get(relationKey(relationMeta.sourceKeyOf(entity))) ?? empty()),
      new Map<Entity, AggregateResponse<Relation>[]>()
    )
  }

  public async addRelations<Relation>(
    relationName: string,
    id: string | number,
    relationIds: (string | number)[],
    opts?: ModifyRelationOptions<Entity, Relation>
  ): Promise<Entity> {
    const entity = await this.getById(id, opts)
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const side = this.assertCollectionRelation(relationMeta, 'add to')

    if (!relationIds.length) {
      return entity
    }

    const rows = await this.loadRelationRows(relationMeta, relationIds, opts?.relationFilter, 'add to')

    if (side === 'through') {
      await this.insertJunctionRows(relationMeta, entity, rows)
    } else {
      await this.pointTargetsAtParent(relationMeta, entity, relationIds)
    }

    return entity
  }

  public async setRelations<Relation>(
    relationName: string,
    id: string | number,
    relationIds: (string | number)[],
    opts?: ModifyRelationOptions<Entity, Relation>
  ): Promise<Entity> {
    const entity = await this.getById(id, opts)
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const side = this.assertCollectionRelation(relationMeta, 'set on')
    // An empty list is legal here and means "detach everything".
    const rows = relationIds.length ? await this.loadRelationRows(relationMeta, relationIds, opts?.relationFilter, 'set on') : []

    // Only the rows the caller may see are replaced, as in `query-typeorm`: an authorizer's `relationFilter` scopes
    // the detach too, so rows outside it stay attached instead of being cleared on behalf of a user who cannot see them.
    await this.detachAllFromParent(relationMeta, entity, opts?.relationFilter)

    if (relationIds.length) {
      if (side === 'through') {
        await this.insertJunctionRows(relationMeta, entity, rows)
      } else {
        await this.pointTargetsAtParent(relationMeta, entity, relationIds)
      }
    }

    return entity
  }

  public async setRelation<Relation>(
    relationName: string,
    id: string | number,
    relationId: string | number,
    opts?: ModifyRelationOptions<Entity, Relation>
  ): Promise<Entity> {
    const entity = await this.getById(id, opts)
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const [row] = await this.loadRelationRows(relationMeta, [relationId], opts?.relationFilter, 'set on')

    switch (relationMeta.foreignKeySide) {
      case 'source':
        await this.pointParentAtTarget(relationMeta, id, row)
        break
      case 'target':
        // Single-valued from the parent's perspective, so the previous holder must be detached first -- whatever
        // `relationFilter` says, or two rows would end up holding the same parent (`query-typeorm` behaves the same).
        await this.detachAllFromParent(relationMeta, entity)
        await this.pointTargetsAtParent(relationMeta, entity, [relationId])
        break
      case 'through':
        await this.detachAllFromParent(relationMeta, entity)
        await this.insertJunctionRows(relationMeta, entity, [row])
        break
      default:
        throw this.ambiguousDirection(relationMeta)
    }

    return entity
  }

  public async removeRelations<Relation>(
    relationName: string,
    id: string | number,
    relationIds: (string | number)[],
    opts?: ModifyRelationOptions<Entity, Relation>
  ): Promise<Entity> {
    const entity = await this.getById(id, opts)
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const side = this.assertCollectionRelation(relationMeta, 'remove from')

    if (!relationIds.length) {
      return entity
    }

    const rows = await this.loadRelationRows(relationMeta, relationIds, opts?.relationFilter, 'remove from')

    if (side === 'through') {
      await this.deleteJunctionRows(relationMeta, entity, rows)
    } else {
      await this.detachTargetsFromParent(relationMeta, entity, relationIds)
    }

    return entity
  }

  public async removeRelation<Relation>(
    relationName: string,
    id: string | number,
    relationId: string | number,
    opts?: ModifyRelationOptions<Entity, Relation>
  ): Promise<Entity> {
    const entity = await this.getById(id, opts)
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const [row] = await this.loadRelationRows(relationMeta, [relationId], opts?.relationFilter, 'remove from')

    switch (relationMeta.foreignKeySide) {
      case 'source':
        await this.pointParentAtTarget(relationMeta, id, undefined)
        break
      case 'target':
        await this.detachTargetsFromParent(relationMeta, entity, [relationId])
        break
      case 'through':
        await this.deleteJunctionRows(relationMeta, entity, [row])
        break
      default:
        throw this.ambiguousDirection(relationMeta)
    }

    return entity
  }

  public getRelationMeta<Relation>(relationName: string): RelationMeta<Entity, Relation> {
    let relationMeta = this.relationMetaCache.get(relationName)

    if (!relationMeta) {
      relationMeta = new RelationMeta<Entity, Relation>(
        this.tableMeta,
        relationName,
        this.tableConfig,
        this.relations,
        this.relationOptions[relationName]?.foreignKeySide
      )
      this.relationMetaCache.set(relationName, relationMeta)
    }

    return relationMeta as RelationMeta<Entity, Relation>
  }

  /**
   * The filter builder for a relation's target table. It resolves the target's *own* relations, because the
   * generated schema offers them on a relation connection too (`TodoItem.subTasks(filter: SubTaskFilter)`, and
   * `SubTaskFilter` has `todoItem`), and an authorizer's `relationFilter` may name one. Without the resolver such a
   * key failed as an unknown column. Relation filters nested inside a relation filter stay unsupported, as on the
   * root query (see `WhereBuilder.relationExists`).
   */
  private targetFilterQueryBuilder<Relation>(relationMeta: RelationMeta<Entity, Relation>): FilterQueryBuilder<Relation> {
    let builder = this.targetFilterQueryBuilders.get(relationMeta.relationName)

    if (!builder) {
      const { targetMeta } = relationMeta
      const targetConfig = this.relations[targetMeta.tableName]
      const targetRelationMetas = new Map<string, RelationMeta<unknown, unknown>>()

      builder = new FilterQueryBuilder<Relation>(targetMeta, (field) => {
        if (!hasOwn(targetConfig.relations, field)) {
          return undefined
        }

        let targetRelationMeta = targetRelationMetas.get(field)
        if (!targetRelationMeta) {
          targetRelationMeta = new RelationMeta<Relation, unknown>(
            targetMeta,
            field,
            targetConfig,
            this.relations
          ) as RelationMeta<unknown, unknown>
          targetRelationMetas.set(field, targetRelationMeta)
        }

        return targetRelationMeta
      }) as FilterQueryBuilder<unknown>
      this.targetFilterQueryBuilders.set(relationMeta.relationName, builder)
    }

    return builder as FilterQueryBuilder<Relation>
  }

  /**
   * Loads a relation for every supplied parent in one query, keyed by the original parent object references so
   * `query-graphql`'s dataloader can look results up by identity.
   */
  private async loadRelations<Relation>(
    relationName: string,
    entities: Entity[],
    query: Query<Relation>
  ): Promise<Map<Entity, Relation[]>> {
    const relationMeta = this.getRelationMeta<Relation>(relationName)
    const results = new Map<Entity, Relation[]>()

    if (!entities.length) {
      return results
    }

    const { field: pkField, column: pkColumn } = this.tableMeta.primaryKey
    const parentIds = entities.map((entity) => (entity as Record<string, unknown>)[pkField])
    const targetFilterQueryBuilder = this.targetFilterQueryBuilder(relationMeta)

    // Drizzle aliases tables inside the relational query builder, so conditions must be built from the table
    // reference it hands to these callbacks rather than from the original column objects.
    const aliasedResolver = (table: unknown) => relationMeta.targetMeta.resolver(table as Record<string, PgColumn>)

    const relationConfig: Record<string, unknown> = {
      limit: query.paging?.limit,
      offset: query.paging?.offset
    }

    if (query.filter) {
      relationConfig.where = {
        RAW: (table: unknown) =>
          toDrizzleRelationsFilter(targetFilterQueryBuilder.whereClause(query.filter, aliasedResolver(table)))
      }
    }

    if (query.sorting?.length) {
      relationConfig.orderBy = (table: unknown) => targetFilterQueryBuilder.orderByClause(query.sorting, aliasedResolver(table))
    }

    // The relation name is a runtime value, so Drizzle's statically-typed query config cannot apply here.
    const queryBuilder = this.db.query[this.tableMeta.tableName] as unknown as {
      findMany(config: unknown): Promise<Record<string, unknown>[]>
    }

    const rows = await queryBuilder.findMany({
      columns: { [pkField]: true },
      where: {
        RAW: (table: unknown) => inArray((table as Record<string, PgColumn>)[pkField] ?? pkColumn, parentIds)
      },
      with: { [relationName]: relationConfig }
    })

    const byParentId = new Map(rows.map((row) => [row[pkField], row[relationName]]))

    for (const entity of entities) {
      const loaded = byParentId.get((entity as Record<string, unknown>)[pkField])

      // `one` relations come back as a single object (or null) rather than an array.
      results.set(entity, Array.isArray(loaded) ? (loaded as Relation[]) : loaded ? [loaded as Relation] : [])
    }

    return results
  }

  /**
   * Builds `SELECT <selection> FROM target [JOIN through] WHERE <join keys match parent> AND <filter>`.
   */
  private relationSelect<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entity: Entity,
    selection: Record<string, SQL | PgColumn>,
    filter: Filter<Relation>,
    groupBy: (SQL | PgColumn)[] = []
  ): Promise<unknown> {
    const sourceKey = relationMeta.sourceKeyOf(entity)
    const conditions: SQL[] = []

    let qb = this.db.select(selection).from(relationMeta.targetMeta.table).$dynamic()

    if (relationMeta.through) {
      const { table, sourceColumns, targetColumns } = relationMeta.through

      qb = qb.innerJoin(table, and(...targetColumns.map((column, index) => eq(column, relationMeta.targetColumns[index]))))
      conditions.push(...sourceColumns.map((column, index) => eq(column, sourceKey[index])))
    } else {
      conditions.push(...relationMeta.targetColumns.map((column, index) => eq(column, sourceKey[index])))
    }

    if (relationMeta.predefinedWhere) {
      conditions.push(relationMeta.predefinedWhere)
    }

    const filterClause = this.targetFilterQueryBuilder(relationMeta).whereClause(filter)
    if (filterClause) {
      conditions.push(filterClause)
    }

    qb = qb.where(and(...conditions))

    if (groupBy.length) {
      qb = qb.groupBy(...groupBy)
    }

    return qb
  }

  /**
   * Aggregates a relation for all supplied parents in one grouped query. The internal key aliases are selected only
   * so the aggregate rows can be mapped back to the original parent object references.
   */
  private async relationAggregateSelectMany<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entities: Entity[],
    selection: Record<string, SQL | PgColumn>,
    filter: Filter<Relation>,
    groupBy: (SQL | PgColumn)[]
  ): Promise<{ rows: Record<string, unknown>[]; keyAliases: string[] }> {
    const keyColumns = relationMeta.through?.sourceColumns ?? relationMeta.targetColumns
    const keyAliases = keyColumns.map((_, index) => `${BATCH_KEY_ALIAS}${index}`)
    const keySelection = Object.fromEntries(keyAliases.map((alias, index) => [alias, keyColumns[index]]))
    const sourceKeys = entities.map((entity) => relationMeta.sourceKeyOf(entity))
    const conditions: SQL[] = [this.matchingKeysClause(keyColumns, sourceKeys)]

    let qb = this.db
      .select({ ...keySelection, ...selection })
      .from(relationMeta.targetMeta.table)
      .$dynamic()

    if (relationMeta.through) {
      const { table, targetColumns } = relationMeta.through
      qb = qb.innerJoin(table, and(...targetColumns.map((column, index) => eq(column, relationMeta.targetColumns[index]))))
    }

    if (relationMeta.predefinedWhere) {
      conditions.push(relationMeta.predefinedWhere)
    }

    const filterClause = this.targetFilterQueryBuilder(relationMeta).whereClause(filter)
    if (filterClause) {
      conditions.push(filterClause)
    }

    const rows = (await qb.where(and(...conditions)).groupBy(...keyColumns, ...groupBy)) as Record<string, unknown>[]

    return { rows, keyAliases }
  }

  private matchingKeysClause(columns: PgColumn[], keys: unknown[][]): SQL {
    if (columns.length === 1) {
      return inArray(
        columns[0],
        keys.map(([value]) => value)
      )
    }

    return or(...keys.map((key) => and(...columns.map((column, index) => eq(column, key[index])))))
  }

  /**
   * Loads the related rows by id, applying `relationFilter`, and fails when any requested id is missing -- the same
   * all-or-nothing contract `query-typeorm` enforces before mutating.
   */
  private async loadRelationRows<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    relationIds: (string | number)[],
    relationFilter: Filter<Relation> | undefined,
    action: string
  ): Promise<Record<string, unknown>[]> {
    const { targetMeta } = relationMeta
    const conditions: SQL[] = [inArray(targetMeta.primaryKey.column, relationIds)]
    const filterClause = this.targetFilterQueryBuilder(relationMeta).whereClause(relationFilter)

    if (relationMeta.predefinedWhere) {
      conditions.push(relationMeta.predefinedWhere)
    }

    if (filterClause) {
      conditions.push(filterClause)
    }

    const rows = (await this.db
      .select()
      .from(targetMeta.table)
      .where(and(...conditions))) as Record<string, unknown>[]

    if (rows.length !== new Set(relationIds).size) {
      throw new Error(`Unable to find all ${relationMeta.relationName} to ${action} ${this.EntityClass.name}`)
    }

    return rows
  }

  /** FK on the target: point the given related rows at this parent. */
  private async pointTargetsAtParent<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entity: Entity,
    relationIds: (string | number)[]
  ): Promise<void> {
    const sourceKey = relationMeta.sourceKeyOf(entity)
    const values = Object.fromEntries(relationMeta.targetFields.map((field, index) => [field, sourceKey[index]]))

    await this.db
      .update(relationMeta.targetMeta.table)
      .set(values)
      .where(inArray(relationMeta.targetMeta.primaryKey.column, relationIds))
  }

  /** FK on the target: null out the FK on the given related rows, but only where they point at this parent. */
  private async detachTargetsFromParent<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entity: Entity,
    relationIds: (string | number)[]
  ): Promise<void> {
    const values = Object.fromEntries(relationMeta.targetFields.map((field) => [field, null]))

    await this.db
      .update(relationMeta.targetMeta.table)
      .set(values)
      .where(and(inArray(relationMeta.targetMeta.primaryKey.column, relationIds), this.parentKeyClause(relationMeta, entity)))
  }

  /** FK on the source: point the parent row at the given related row, or clear it when `row` is undefined. */
  private async pointParentAtTarget<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    id: string | number,
    row: Record<string, unknown> | undefined
  ): Promise<void> {
    const targetFields = relationMeta.targetFields
    const values = Object.fromEntries(
      relationMeta.sourceFields.map((field, index) => [field, row ? row[targetFields[index]] : null])
    )

    await this.db.update(this.tableMeta.table).set(values).where(eq(this.tableMeta.primaryKey.column, id))
  }

  private async insertJunctionRows<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entity: Entity,
    rows: Record<string, unknown>[]
  ): Promise<void> {
    const { through, targetFields } = relationMeta
    const sourceKey = relationMeta.sourceKeyOf(entity)

    const values = rows.map((row) => ({
      ...Object.fromEntries(through.sourceFields.map((field, index) => [field, sourceKey[index]])),
      ...Object.fromEntries(through.targetFields.map((field, index) => [field, row[targetFields[index]]]))
    }))

    await this.db.insert(through.table).values(values).onConflictDoNothing()
  }

  private async deleteJunctionRows<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entity: Entity,
    rows: Record<string, unknown>[]
  ): Promise<void> {
    const { through, targetFields } = relationMeta
    const matchesAnyRow = or(
      ...rows.map((row) => and(...through.targetColumns.map((column, index) => eq(column, row[targetFields[index]]))))
    )

    await this.db.delete(through.table).where(and(this.parentKeyClause(relationMeta, entity), matchesAnyRow))
  }

  /**
   * Detaches every currently related row from this parent that the relation's predefined `where` and the optional
   * `relationFilter` both match, so a `set` can replace the whole (visible) collection.
   */
  private async detachAllFromParent<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    entity: Entity,
    relationFilter?: Filter<Relation>
  ): Promise<void> {
    const parentKey = this.parentKeyClause(relationMeta, entity)
    const restriction = this.targetRestrictionClause(relationMeta, relationFilter)

    if (relationMeta.through) {
      await this.db
        .delete(relationMeta.through.table)
        .where(and(parentKey, this.junctionRestrictionClause(relationMeta, restriction)))

      return
    }

    const values = Object.fromEntries(relationMeta.targetFields.map((field) => [field, null]))

    // Without the relation's own filter this would detach rows the relation never contained -- `setRelations` on
    // `completedSubTasks` would clear the foreign key of the incomplete sub tasks too.
    await this.db.update(relationMeta.targetMeta.table).set(values).where(and(parentKey, restriction))
  }

  /** `<predefined where> AND <relationFilter>` against the related table, or `undefined` when neither applies. */
  private targetRestrictionClause<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    relationFilter?: Filter<Relation>
  ): SQL | undefined {
    const filterClause = this.targetFilterQueryBuilder(relationMeta).whereClause(relationFilter)
    const clauses = [relationMeta.predefinedWhere, filterClause].filter((clause): clause is SQL => !!clause)

    return clauses.length ? and(...clauses) : undefined
  }

  /**
   * The junction-table form of a restriction written against the related table: a `DELETE FROM junction` never
   * touches that table, so the restriction has to arrive as a subquery on the junction's key.
   */
  private junctionRestrictionClause<Relation>(
    relationMeta: RelationMeta<Entity, Relation>,
    restriction: SQL | undefined
  ): SQL | undefined {
    const { through } = relationMeta

    if (!restriction || !through) {
      return undefined
    }

    if (through.targetColumns.length !== 1) {
      throw new Error(
        `Relation "${relationMeta.relationName}" is filtered (by a predefined "where" or a relationFilter) and joins ` +
          'through a composite key, which @ptc-org/nestjs-query-drizzle cannot detach safely.'
      )
    }

    return inArray(
      through.targetColumns[0],
      this.db.select({ value: relationMeta.targetColumns[0] }).from(relationMeta.targetMeta.table).where(restriction)
    )
  }

  /**
   * `<fk columns> = <parent key>`, against the junction table when the relation goes through one, otherwise
   * against the related table.
   */
  private parentKeyClause<Relation>(relationMeta: RelationMeta<Entity, Relation>, entity: Entity): SQL {
    const sourceKey = relationMeta.sourceKeyOf(entity)
    const columns = relationMeta.through ? relationMeta.through.sourceColumns : relationMeta.targetColumns

    return and(...columns.map((column, index) => eq(column, sourceKey[index])))
  }

  /** Plural relation operations are meaningless when the parent row itself holds a single foreign key. */
  private assertCollectionRelation<Relation>(relationMeta: RelationMeta<Entity, Relation>, action: string): 'target' | 'through' {
    if (relationMeta.foreignKeySide === 'target' || relationMeta.foreignKeySide === 'through') {
      return relationMeta.foreignKeySide
    }

    if (relationMeta.foreignKeySide === 'ambiguous') {
      throw this.ambiguousDirection(relationMeta)
    }

    throw new MethodNotAllowedException(
      `Cannot ${action} multiple "${relationMeta.relationName}" on ${this.EntityClass.name}: the foreign key lives on ` +
        `${this.tableMeta.tableName}, so the relation holds a single value. Use setRelation/removeRelation instead.`
    )
  }

  private ambiguousDirection<Relation>(relationMeta: RelationMeta<Entity, Relation>): Error {
    return new MethodNotAllowedException(
      `Cannot mutate relation "${relationMeta.relationName}" on ${this.EntityClass.name}: both sides of the relation ` +
        'are primary keys, so which side owns the foreign key is ambiguous.'
    )
  }
}
