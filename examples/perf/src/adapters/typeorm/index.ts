/* Entity classes reference each other in both directions -- that is how these ORMs express relations,
   and the lazy `() => Entity` thunks make the ordering irrelevant at runtime. */
/* eslint-disable @typescript-eslint/no-use-before-define */
import { INestApplication } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'
import { NestjsQueryTypeOrmModule } from '@ptc-org/nestjs-query-typeorm'
import { Column, DataSource, Entity, Index, JoinTable, ManyToMany, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm'

import { NestImport, PerfAdapter, SeedSizes } from '../../adapter'
import { RESOLVER_SPECS } from '../../dto/resolvers'
import { SubTaskDTO, TagDTO, TodoItemDTO } from '../../dto/sql'
import { postgresParams } from '../postgres.config'

// Composite index matching every read scenario's filter -- see the seeder for why the column order matters.
@Index('todo_item_completed_priority_idx', ['completed', 'priority'])
@Entity({ name: 'todo_item' })
export class TodoItemEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  title!: string

  @Column({ default: false })
  completed!: boolean

  @Column({ default: 0 })
  priority!: number

  @OneToMany(() => SubTaskEntity, (subTask) => subTask.todoItem)
  subTasks!: SubTaskEntity[]

  @ManyToMany(() => TagEntity, (tag) => tag.todoItems)
  @JoinTable({
    name: 'todo_item_tags',
    joinColumn: { name: 'todo_item_id' },
    inverseJoinColumn: { name: 'tag_id' }
  })
  tags!: TagEntity[]
}

@Entity({ name: 'sub_task' })
export class SubTaskEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  title!: string

  @Column({ default: false })
  completed!: boolean

  @Index()
  @Column({ name: 'todo_item_id', nullable: true })
  todoItemId?: number

  @ManyToOne(() => TodoItemEntity, (todoItem) => todoItem.subTasks, { onDelete: 'CASCADE', nullable: true })
  todoItem?: TodoItemEntity
}

@Entity({ name: 'tag' })
export class TagEntity {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  name!: string

  @ManyToMany(() => TodoItemEntity, (todoItem) => todoItem.tags)
  todoItems!: TodoItemEntity[]
}

const DTOS = { todoItem: TodoItemDTO, subTask: SubTaskDTO, tag: TagDTO }
const ENTITIES = { todoItem: TodoItemEntity, subTask: SubTaskEntity, tag: TagEntity }

const features = (): NestImport[] =>
  RESOLVER_SPECS.map(({ key, CreateDTOClass, UpdateDTOClass }) =>
    NestjsQueryGraphQLModule.forFeature({
      imports: [NestjsQueryTypeOrmModule.forFeature([ENTITIES[key]])],
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

export const typeormAdapter: PerfAdapter = {
  name: 'typeorm',
  backend: 'postgres',

  imports: (): NestImport[] => [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: postgresParams.host,
      port: postgresParams.port,
      username: postgresParams.username,
      database: postgresParams.database,
      entities: [TodoItemEntity, SubTaskEntity, TagEntity],
      synchronize: true,
      dropSchema: true,
      logging: false
    }),
    ...features()
  ],

  async seed(app: INestApplication, sizes: SeedSizes): Promise<void> {
    // `dropSchema: true` + `synchronize: true` already rebuilt the tables; only the rows are inserted here, and
    // via raw SQL so the ORM's own insert path never shows up in setup time.
    const dataSource = app.get(DataSource)

    await dataSource.query(`
      INSERT INTO todo_item (title, completed, priority)
      SELECT 'Todo Item ' || n, n % 4 = 0, n % 10 FROM generate_series(1, ${sizes.todoItems}) AS n
    `)
    await dataSource.query(`INSERT INTO tag (name) SELECT 'Tag ' || n FROM generate_series(1, ${sizes.tags}) AS n`)
    await dataSource.query(`
      INSERT INTO sub_task (title, completed, todo_item_id)
      SELECT t.title || ' - Sub Task ' || s.n, s.n = 1, t.id
      FROM todo_item t CROSS JOIN generate_series(1, ${sizes.subTasksPerItem}) AS s(n)
    `)
    await dataSource.query(`
      INSERT INTO todo_item_tags (todo_item_id, tag_id)
      SELECT t.id, 1 + ((t.id * 7 + s.n * 13) % ${sizes.tags})
      FROM todo_item t CROSS JOIN generate_series(1, ${sizes.tagsPerItem}) AS s(n)
      ON CONFLICT DO NOTHING
    `)
    await dataSource.query('VACUUM (ANALYZE) todo_item')
    await dataSource.query('ANALYZE sub_task, tag, todo_item_tags')
  }
}
