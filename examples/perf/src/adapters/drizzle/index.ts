import { Global, INestApplication, Module } from '@nestjs/common'
import { NestjsQueryDrizzleModule } from '@ptc-org/nestjs-query-drizzle'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'
import { defineRelations, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { boolean, integer, pgTable, serial, text } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'

import type { DrizzleDatabase } from '@ptc-org/nestjs-query-drizzle'

import { NestImport, PerfAdapter, SeedSizes } from '../../adapter'
import { RESOLVER_SPECS } from '../../dto/resolvers'
import { SubTaskDTO, TagDTO, TodoItemDTO } from '../../dto/sql'
import { postgresConnection } from '../postgres.config'

const todoItem = pgTable('todo_item', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  priority: integer('priority').notNull().default(0)
})

const subTask = pgTable('sub_task', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  todoItemId: integer('todo_item_id')
})

const tag = pgTable('tag', {
  id: serial('id').primaryKey(),
  name: text('name').notNull()
})

const todoItemTags = pgTable('todo_item_tags', {
  todoItemId: integer('todo_item_id').notNull(),
  tagId: integer('tag_id').notNull()
})

const relations = defineRelations({ todoItem, subTask, tag, todoItemTags }, (r) => ({
  todoItem: {
    subTasks: r.many.subTask({ from: r.todoItem.id, to: r.subTask.todoItemId }),
    tags: r.many.tag({
      from: r.todoItem.id.through(r.todoItemTags.todoItemId),
      to: r.tag.id.through(r.todoItemTags.tagId)
    })
  },
  subTask: {
    todoItem: r.one.todoItem({ from: r.subTask.todoItemId, to: r.todoItem.id })
  }
}))

const DRIZZLE_DB = 'PERF_DRIZZLE_DB'

@Global()
@Module({
  providers: [
    { provide: Pool, useFactory: () => new Pool(postgresConnection()) },
    {
      provide: DRIZZLE_DB,
      // Drizzle v1 takes an existing client as `{ client }`; passing it positionally is the v0 API.
      useFactory: (pool: Pool) => drizzle({ client: pool, relations }),
      inject: [Pool]
    }
  ],
  exports: [DRIZZLE_DB, Pool]
})
class DrizzleConnectionModule {}

const DTOS = { todoItem: TodoItemDTO, subTask: SubTaskDTO, tag: TagDTO }

const features = (): NestImport[] =>
  RESOLVER_SPECS.map(({ key, CreateDTOClass, UpdateDTOClass }) => {
    const DTOClass = DTOS[key]

    return NestjsQueryGraphQLModule.forFeature({
      imports: [
        NestjsQueryDrizzleModule.forFeature([{ DTOClass: DTOClass as never, tableName: key }], {
          dbToken: DRIZZLE_DB,
          relations
        })
      ],
      // Drizzle has no entity class, so the DTO doubles as the entity.
      resolvers: [
        { DTOClass: DTOClass as never, EntityClass: DTOClass as never, CreateDTOClass, UpdateDTOClass, enableAggregate: true }
      ]
    })
  })

export const drizzleAdapter: PerfAdapter = {
  name: 'drizzle',
  backend: 'postgres',

  imports: (): NestImport[] => [DrizzleConnectionModule, ...features()],

  async seed(app: INestApplication, sizes: SeedSizes): Promise<void> {
    const db = app.get<DrizzleDatabase>(DRIZZLE_DB)

    await db.execute(sql`DROP TABLE IF EXISTS todo_item_tags, sub_task, tag, todo_item CASCADE`)
    await db.execute(sql`
      CREATE TABLE todo_item (
        id serial PRIMARY KEY,
        title text NOT NULL,
        completed boolean NOT NULL DEFAULT false,
        priority integer NOT NULL DEFAULT 0
      )
    `)
    await db.execute(sql`
      CREATE TABLE sub_task (
        id serial PRIMARY KEY,
        title text NOT NULL,
        completed boolean NOT NULL DEFAULT false,
        todo_item_id integer REFERENCES todo_item (id) ON DELETE CASCADE
      )
    `)
    await db.execute(sql`CREATE TABLE tag (id serial PRIMARY KEY, name text NOT NULL)`)
    await db.execute(sql`
      CREATE TABLE todo_item_tags (
        todo_item_id integer NOT NULL REFERENCES todo_item (id) ON DELETE CASCADE,
        tag_id integer NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
        PRIMARY KEY (todo_item_id, tag_id)
      )
    `)

    await db.execute(sql`CREATE INDEX sub_task_todo_item_id_idx ON sub_task (todo_item_id)`)
    await db.execute(sql`CREATE INDEX todo_item_tags_tag_id_idx ON todo_item_tags (tag_id)`)
    // Every read scenario filters on `completed = false AND priority >= n`. A `priority`-only index leaves
    // `completed` to be rechecked from the heap, which is what actually dominates a COUNT at scale; the
    // composite puts the equality column first so the range column can still be used, and VACUUM populates
    // the visibility map so Postgres can choose an index-only scan (1542 -> 71 buffers on 200k rows).
    await db.execute(sql`CREATE INDEX todo_item_completed_priority_idx ON todo_item (completed, priority)`)

    await db.execute(sql`
      INSERT INTO todo_item (title, completed, priority)
      SELECT 'Todo Item ' || n, n % 4 = 0, n % 10 FROM generate_series(1, ${sizes.todoItems}) AS n
    `)
    await db.execute(sql`INSERT INTO tag (name) SELECT 'Tag ' || n FROM generate_series(1, ${sizes.tags}) AS n`)
    await db.execute(sql`
      INSERT INTO sub_task (title, completed, todo_item_id)
      SELECT t.title || ' - Sub Task ' || s.n, s.n = 1, t.id
      FROM todo_item t CROSS JOIN generate_series(1, ${sizes.subTasksPerItem}) AS s(n)
    `)
    await db.execute(sql`
      INSERT INTO todo_item_tags (todo_item_id, tag_id)
      SELECT t.id, 1 + ((t.id * 7 + s.n * 13) % ${sizes.tags})
      FROM todo_item t CROSS JOIN generate_series(1, ${sizes.tagsPerItem}) AS s(n)
      ON CONFLICT DO NOTHING
    `)
    await db.execute(sql`VACUUM (ANALYZE) todo_item`)
    await db.execute(sql`ANALYZE sub_task, tag, todo_item_tags`)
  }
}
