import { ConflictException, MethodNotAllowedException, NotFoundException } from '@nestjs/common'
import {
  AggregateOptions,
  AggregateQuery,
  AggregateResponse,
  Class,
  CountOptions,
  DeepPartial,
  DeleteManyOptions,
  DeleteManyResponse,
  DeleteOneOptions,
  Filter,
  FindByIdOptions,
  GetByIdOptions,
  Query,
  QueryOptions,
  QueryService,
  UpdateManyResponse,
  UpdateOneOptions
} from '@ptc-org/nestjs-query-core'
import { and, eq, SQL } from 'drizzle-orm'

import type { TableRelationalConfig, TablesRelationalConfig } from 'drizzle-orm'

import { AggregateBuilder, FilterQueryBuilder, RelationMeta, TableMeta } from '../query'
import { DrizzleDatabase, NestjsQueryDrizzleRelationOptions } from '../typings'
import { RelationQueryService } from './relation-query.service'

/**
 * Base class for all query services backed by a Drizzle `db` instance.
 *
 * Two behaviours worth knowing about:
 *
 * - **Rows are returned as-is.** Drizzle returns plain objects keyed by the table's JS property names, and this
 *   service passes them straight through rather than instantiating the DTO class. `class-transformer` decorators
 *   on a Drizzle-backed DTO therefore have no effect here -- use an `Assembler` if you need a conversion step.
 * - **Soft delete is not supported.** `withDeleted` is ignored because rows are never hidden. Delete operations
 *   reject `useSoftDelete: true` instead of silently turning a requested soft delete into a permanent hard delete.
 *
 * @example
 *
 * ```ts
 * @QueryService(TodoItemDto)
 * export class TodoItemService extends DrizzleQueryService<TodoItemDto> {
 *   constructor(@Inject(DB_TOKEN) db: DrizzleDatabase) {
 *     super(db, TodoItemDto, 'todoItem', relations);
 *   }
 * }
 * ```
 */
export class DrizzleQueryService<Entity>
  extends RelationQueryService<Entity>
  implements QueryService<Entity, DeepPartial<Entity>, DeepPartial<Entity>>
{
  readonly db: DrizzleDatabase

  // eslint-disable-next-line @typescript-eslint/naming-convention
  readonly EntityClass: Class<Entity>

  readonly tableConfig: TableRelationalConfig

  readonly relations: TablesRelationalConfig

  readonly tableMeta: TableMeta<Entity>

  readonly filterQueryBuilder: FilterQueryBuilder<Entity>

  readonly aggregateBuilder: AggregateBuilder<Entity>

  readonly relationOptions: Record<string, NestjsQueryDrizzleRelationOptions>

  constructor(
    db: DrizzleDatabase,
    DTOClass: Class<Entity>,
    tableName: string,
    relations: TablesRelationalConfig,
    relationOptions: Record<string, NestjsQueryDrizzleRelationOptions> = {}
  ) {
    super()

    const tableConfig = relations[tableName]
    if (!tableConfig) {
      throw new Error(
        `Unknown table "${tableName}". Available tables: ${Object.keys(relations).join(', ')}. ` +
          'Make sure the table is part of the schema passed to defineRelations().'
      )
    }

    const relationalQueries = db.query as unknown as Record<string, unknown>
    if (!relationalQueries?.[tableName]) {
      throw new Error(
        `Drizzle relational query builder for table "${tableName}" is unavailable. ` +
          'Make sure the same relations object passed to NestjsQueryDrizzleModule.forFeature() is also passed to drizzle().'
      )
    }

    const unknownRelationOptions = Object.keys(relationOptions).filter((relationName) => !tableConfig.relations[relationName])
    if (unknownRelationOptions.length) {
      throw new Error(
        `Unknown relationOptions for table "${tableName}": ${unknownRelationOptions.join(', ')}. ` +
          `Available relations: ${Object.keys(tableConfig.relations).join(', ') || '(none)'}.`
      )
    }

    this.db = db
    this.EntityClass = DTOClass
    this.relations = relations
    this.relationOptions = relationOptions
    this.tableConfig = tableConfig
    this.tableMeta = new TableMeta<Entity>(tableConfig.table, tableName)
    // Lazy: `getRelationMeta` lives on the relation mixin and caches, and the guard keeps plain column names off
    // that path entirely, so an unknown key still fails with the column error rather than the relation one.
    this.filterQueryBuilder = new FilterQueryBuilder<Entity>(this.tableMeta, (field) =>
      this.tableConfig.relations[field] ? (this.getRelationMeta(field) as RelationMeta<unknown, unknown>) : undefined
    )
    this.aggregateBuilder = new AggregateBuilder<Entity>(this.tableMeta)
  }

  /**
   * Query for multiple entities.
   *
   * @example
   * ```ts
   * const todoItems = await this.service.query({
   *   filter: { title: { eq: 'Foo' } },
   *   paging: { limit: 10 },
   *   sorting: [{ field: 'created', direction: SortDirection.DESC }],
   * });
   * ```
   */
  public async query(query: Query<Entity>, opts?: QueryOptions<Entity>): Promise<Entity[]> {
    void opts
    const qb = this.db.select().from(this.tableMeta.table).$dynamic()

    return (await this.filterQueryBuilder.applyQuery(qb, query)) as Entity[]
  }

  public async aggregate(
    filter: Filter<Entity>,
    aggregate: AggregateQuery<Entity>,
    opts?: AggregateOptions
  ): Promise<AggregateResponse<Entity>[]> {
    void opts
    const { selection, groupBy, convert } = this.aggregateBuilder.build(aggregate)

    const qb = this.filterQueryBuilder.applyAggregate(
      this.db.select(selection).from(this.tableMeta.table).$dynamic(),
      filter,
      groupBy
    )

    return convert((await qb) as Record<string, unknown>[])
  }

  public async count(filter: Filter<Entity>, opts?: CountOptions): Promise<number> {
    void opts
    return this.db.$count(this.tableMeta.table, this.filterQueryBuilder.whereClause(filter))
  }

  /**
   * Find an entity by its `id`, returning `undefined` when it does not exist.
   */
  public async findById(id: string | number, opts?: FindByIdOptions<Entity>): Promise<Entity | undefined> {
    const rows = (await this.db.select().from(this.tableMeta.table).where(this.byIdClause(id, opts?.filter)).limit(1)) as Entity[]

    return rows[0]
  }

  /**
   * Get an entity by its `id`, rejecting when it does not exist.
   */
  public async getById(id: string | number, opts?: GetByIdOptions<Entity>): Promise<Entity> {
    const entity = await this.findById(id, opts)

    if (!entity) {
      throw new NotFoundException(`Unable to find ${this.EntityClass.name} with id: ${id}`)
    }

    return entity
  }

  public async createOne(record: DeepPartial<Entity>): Promise<Entity> {
    const [created] = await this.insertRecords([record])

    return created
  }

  public async createMany(records: DeepPartial<Entity>[]): Promise<Entity[]> {
    if (!records.length) {
      return []
    }

    return this.insertRecords(records)
  }

  public async updateOne(id: string | number, update: DeepPartial<Entity>, opts?: UpdateOneOptions<Entity>): Promise<Entity> {
    this.ensureIdIsNotPresent(update)

    const [updated] = (await this.db
      .update(this.tableMeta.table)
      .set(update)
      .where(this.byIdClause(id, opts?.filter))
      .returning()) as Entity[]

    if (!updated) {
      throw new NotFoundException(`Unable to find ${this.EntityClass.name} with id: ${id}`)
    }

    return updated
  }

  public async updateMany(update: DeepPartial<Entity>, filter: Filter<Entity>): Promise<UpdateManyResponse> {
    this.ensureIdIsNotPresent(update)

    const updated = await this.db
      .update(this.tableMeta.table)
      .set(update)
      .where(this.filterQueryBuilder.whereClause(filter))
      .returning({ id: this.tableMeta.primaryKey.column })

    return { updatedCount: updated.length }
  }

  public async deleteOne(id: number | string, opts?: DeleteOneOptions<Entity>): Promise<Entity> {
    this.assertSoftDeleteIsDisabled(opts)
    const [entity] = (await this.db.delete(this.tableMeta.table).where(this.byIdClause(id, opts?.filter)).returning()) as Entity[]

    if (!entity) {
      throw new NotFoundException(`Unable to find ${this.EntityClass.name} with id: ${id}`)
    }

    return entity
  }

  public async deleteMany(filter: Filter<Entity>, opts?: DeleteManyOptions<Entity>): Promise<DeleteManyResponse> {
    this.assertSoftDeleteIsDisabled(opts)
    const deleted = await this.db
      .delete(this.tableMeta.table)
      .where(this.filterQueryBuilder.whereClause(filter))
      .returning({ id: this.tableMeta.primaryKey.column })

    return { deletedCount: deleted.length }
  }

  private byIdClause(id: string | number, filter?: Filter<Entity>): SQL {
    const idClause = eq(this.tableMeta.primaryKey.column, id)
    const filterClause = this.filterQueryBuilder.whereClause(filter)

    return filterClause ? and(idClause, filterClause) : idClause
  }

  private async insertRecords(records: DeepPartial<Entity>[]): Promise<Entity[]> {
    try {
      return (await this.db.insert(this.tableMeta.table).values(records).returning()) as Entity[]
    } catch (error) {
      if (this.postgresErrorCode(error) === '23505') {
        throw new ConflictException(`${this.EntityClass.name} already exists`)
      }

      throw error
    }
  }

  private postgresErrorCode(error: unknown): string | undefined {
    const seen = new Set<unknown>()
    let current = error

    while (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current)
      const candidate = current as { cause?: unknown; code?: unknown }
      if (typeof candidate.code === 'string') {
        return candidate.code
      }
      current = candidate.cause
    }

    return undefined
  }

  private ensureIdIsNotPresent(record: DeepPartial<Entity>): void {
    const id = (record as Record<string, unknown>)[this.tableMeta.primaryKey.field]

    if (id !== undefined && id !== null) {
      throw new Error('Id cannot be specified when updating')
    }
  }

  private assertSoftDeleteIsDisabled(opts?: DeleteOneOptions<Entity>): void {
    if (opts?.useSoftDelete) {
      throw new MethodNotAllowedException(
        '@ptc-org/nestjs-query-drizzle does not support soft delete. The operation was rejected without deleting data.'
      )
    }
  }
}
