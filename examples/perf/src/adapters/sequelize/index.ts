/* Entity classes reference each other in both directions -- that is how these ORMs express relations,
   and the lazy `() => Entity` thunks make the ordering irrelevant at runtime. */
/* eslint-disable @typescript-eslint/no-use-before-define, max-classes-per-file */
import { INestApplication } from '@nestjs/common'
import { SequelizeModule } from '@nestjs/sequelize'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'
import { NestjsQuerySequelizeModule } from '@ptc-org/nestjs-query-sequelize'
import {
  AutoIncrement,
  BelongsTo,
  BelongsToMany,
  Column,
  ForeignKey,
  HasMany,
  Index,
  Model,
  PrimaryKey,
  Sequelize,
  Table
} from 'sequelize-typescript'

import { NestImport, PerfAdapter, SeedSizes } from '../../adapter'
import { RESOLVER_SPECS } from '../../dto/resolvers'
import { SubTaskDTO, TagDTO, TodoItemDTO } from '../../dto/sql'
import { postgresParams } from '../postgres.config'

@Table({ tableName: 'todo_item', timestamps: false })
export class TodoItemEntity extends Model<TodoItemEntity, Partial<TodoItemEntity>> {
  @PrimaryKey
  @AutoIncrement
  @Column
  id!: number

  @Column
  title!: string

  // Composite index matching every read scenario's filter; `completed` first because it is the equality column.
  @Index('todo_item_completed_priority_idx')
  @Column({ defaultValue: false })
  completed!: boolean

  @Index('todo_item_completed_priority_idx')
  @Column({ defaultValue: 0 })
  priority!: number

  @HasMany(() => SubTaskEntity)
  subTasks!: SubTaskEntity[]

  @BelongsToMany(() => TagEntity, () => TodoItemTagEntity)
  tags!: TagEntity[]
}

@Table({ tableName: 'sub_task', timestamps: false })
export class SubTaskEntity extends Model<SubTaskEntity, Partial<SubTaskEntity>> {
  @PrimaryKey
  @AutoIncrement
  @Column
  id!: number

  @Column
  title!: string

  @Column({ defaultValue: false })
  completed!: boolean

  @Index
  @ForeignKey(() => TodoItemEntity)
  @Column({ allowNull: true })
  todoItemId?: number

  @BelongsTo(() => TodoItemEntity)
  todoItem?: TodoItemEntity
}

@Table({ tableName: 'tag', timestamps: false })
export class TagEntity extends Model<TagEntity, Partial<TagEntity>> {
  @PrimaryKey
  @AutoIncrement
  @Column
  id!: number

  @Column
  name!: string

  @BelongsToMany(() => TodoItemEntity, () => TodoItemTagEntity)
  todoItems!: TodoItemEntity[]
}

@Table({ tableName: 'todo_item_tags', timestamps: false })
export class TodoItemTagEntity extends Model<TodoItemTagEntity, Partial<TodoItemTagEntity>> {
  @ForeignKey(() => TodoItemEntity)
  @Column({ primaryKey: true })
  todoItemId!: number

  @Index
  @ForeignKey(() => TagEntity)
  @Column({ primaryKey: true })
  tagId!: number
}

const ENTITIES = { todoItem: TodoItemEntity, subTask: SubTaskEntity, tag: TagEntity }
const DTOS = { todoItem: TodoItemDTO, subTask: SubTaskDTO, tag: TagDTO }

const features = (): NestImport[] =>
  RESOLVER_SPECS.map(({ key, CreateDTOClass, UpdateDTOClass }) =>
    NestjsQueryGraphQLModule.forFeature({
      imports: [NestjsQuerySequelizeModule.forFeature([ENTITIES[key]])],
      resolvers: [
        {
          DTOClass: DTOS[key] as never,
          EntityClass: ENTITIES[key] as never,
          CreateDTOClass,
          UpdateDTOClass,
          enableAggregate: true
        }
      ]
    })
  )

export const sequelizeAdapter: PerfAdapter = {
  name: 'sequelize',
  backend: 'postgres',

  imports: (): NestImport[] => [
    SequelizeModule.forRoot({
      dialect: 'postgres',
      host: postgresParams.host,
      port: postgresParams.port,
      username: postgresParams.username,
      database: postgresParams.database,
      models: [TodoItemEntity, SubTaskEntity, TagEntity, TodoItemTagEntity],
      synchronize: true,
      logging: false
    }),
    ...features()
  ],

  async seed(app: INestApplication, sizes: SeedSizes): Promise<void> {
    const sequelize = app.get(Sequelize)

    // `sync({ force: true })` rebuilds the schema; rows then go in via raw SQL so the ORM's insert path is not
    // folded into setup time. Sequelize owns this schema while it runs, so the raw SQL below uses its own
    // camelCase column names -- only the GraphQL API and the seeded data need to match the other adapters.
    await sequelize.sync({ force: true })

    await sequelize.query(`
      INSERT INTO todo_item (title, completed, priority)
      SELECT 'Todo Item ' || n, n % 4 = 0, n % 10 FROM generate_series(1, ${sizes.todoItems}) AS n
    `)
    await sequelize.query(`INSERT INTO tag (name) SELECT 'Tag ' || n FROM generate_series(1, ${sizes.tags}) AS n`)
    await sequelize.query(`
      INSERT INTO sub_task (title, completed, "todoItemId")
      SELECT t.title || ' - Sub Task ' || s.n, s.n = 1, t.id
      FROM todo_item t CROSS JOIN generate_series(1, ${sizes.subTasksPerItem}) AS s(n)
    `)
    await sequelize.query(`
      INSERT INTO todo_item_tags ("todoItemId", "tagId")
      SELECT t.id, 1 + ((t.id * 7 + s.n * 13) % ${sizes.tags})
      FROM todo_item t CROSS JOIN generate_series(1, ${sizes.tagsPerItem}) AS s(n)
      ON CONFLICT DO NOTHING
    `)
    await sequelize.query('VACUUM (ANALYZE) todo_item')
    await sequelize.query('ANALYZE sub_task, tag, todo_item_tags')
  }
}
