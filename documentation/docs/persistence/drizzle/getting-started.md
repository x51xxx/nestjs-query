---
title: Getting Started
---

The `@ptc-org/nestjs-query-drizzle` package provides an implementation of `@ptc-org/nestjs-query-core`
[QueryService](../../concepts/services.md) backed by [Drizzle ORM](https://orm.drizzle.team/).

This package targets **Drizzle v1 (`1.0.0-rc.x`)** and **PostgreSQL only**. It is built on Drizzle's
[Relations v2 API](https://orm.drizzle.team/docs/relations-v1-v2) (`defineRelations`), so it requires the v1
relations format rather than the older `relations()` helper.

## Installation

```sh
npm i @ptc-org/nestjs-query-drizzle drizzle-orm@1.0.0-rc.4
```

Verified against `1.0.0-rc.4` and the `1.0.0-rc.5` line. Pin the exact version: the v1 relations API still shifts
between release candidates (rc.5, for instance, made `undefined` an error inside relation filters rather than a
skipped field).

## Defining the schema

Drizzle tables are plain objects, and relations live in a single `defineRelations()` call. The adapter needs both.

```ts title="schema.ts"
import { boolean, integer, pgTable, serial, text } from 'drizzle-orm/pg-core'
import { defineRelations } from 'drizzle-orm'

export const todoItem = pgTable('todo_item', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false)
})

export const subTask = pgTable('sub_task', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  todoItemId: integer('todo_item_id')
})

export const schema = { todoItem, subTask }

export const relations = defineRelations(schema, (r) => ({
  todoItem: {
    subTasks: r.many.subTask({ from: r.todoItem.id, to: r.subTask.todoItemId })
  },
  subTask: {
    todoItem: r.one.todoItem({ from: r.subTask.todoItemId, to: r.todoItem.id })
  }
}))

export const DRIZZLE_DB = 'DRIZZLE_DB'
```

## Providing the connection

Drizzle has no official NestJS module, so your application owns the connection and exposes the `db` instance under
a DI token of your choosing.

```ts title="database.module.ts"
import { Module } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { DRIZZLE_DB, relations } from './schema'

@Module({
  providers: [
    {
      provide: DRIZZLE_DB,
      useFactory: () => drizzle({ client: new Pool({ connectionString: process.env.DATABASE_URL }), relations })
    }
  ],
  exports: [DRIZZLE_DB]
})
export class DatabaseModule {}
```

:::note
Two things are easy to get wrong here:

- Pass `relations` (not `schema`) to `drizzle()`. The adapter relies on Drizzle's relational query builder, which
  is only available when the relations config is supplied.
- Pass an existing client as `{ client: pool }`. Handing the pool in positionally (`drizzle(pool, { relations })`)
  is the Drizzle v0 API — under v1 it is ignored and Drizzle silently builds its own pool from default connection
  settings.
  :::

## Wiring up a module

`NestjsQueryDrizzleModule.forFeature` maps each DTO class to a table name — the key used for that table in the
object you passed to `defineRelations()`.

```ts title="todo-item.module.ts"
import { Module } from '@nestjs/common'
import { NestjsQueryDrizzleModule } from '@ptc-org/nestjs-query-drizzle'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'

import { DatabaseModule } from '../database.module'
import { DRIZZLE_DB, relations } from '../schema'
import { TodoItemDTO } from './dto/todo-item.dto'

@Module({
  imports: [
    NestjsQueryGraphQLModule.forFeature({
      imports: [
        NestjsQueryDrizzleModule.forFeature([{ DTOClass: TodoItemDTO, tableName: 'todoItem' }], {
          imports: [DatabaseModule],
          dbToken: DRIZZLE_DB,
          relations
        })
      ],
      resolvers: [
        {
          DTOClass: TodoItemDTO,
          // Drizzle has no entity class, so the DTO doubles as the entity.
          EntityClass: TodoItemDTO,
          enableAggregate: true
        }
      ]
    })
  ]
})
export class TodoItemModule {}
```

Unlike the TypeORM or Mongoose adapters there is no separate entity class: rows come back as plain objects keyed by
the table's property names, so the DTO describes both the GraphQL type and the row shape.

## Relations

All three foreign-key layouts are supported for both reading and mutating:

| Layout                                       | Example                                                                       | Mutation applies to |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| belongs-to (FK on the declaring table)       | `r.one.todoItem({ from: r.subTask.todoItemId, to: r.todoItem.id })`           | the parent row      |
| has-one / has-many (FK on the related table) | `r.many.subTask({ from: r.todoItem.id, to: r.subTask.todoItemId })`           | the related rows    |
| many-to-many (`through`)                     | `r.many.tag({ from: r.todoItem.id.through(...), to: r.tag.id.through(...) })` | the junction table  |

Relation reads go through Drizzle's relational query builder, which emits a `LEFT JOIN LATERAL`. This means paging
on a relation applies **per parent**, so each parent in a batched request gets its own page of results.

Relation counts and aggregates are batched as well. For a DataLoader batch of N parents, the adapter selects the
relation join key, restricts it with `IN (...)`, and groups by that key (plus any requested aggregate `groupBy`
fields). Direct and `through` relations therefore use one aggregate SQL statement for the whole batch rather than
N statements. A GraphQL connection selecting parent rows, relation edges and relation `totalCount` has a stable
three-query shape regardless of the number of parents.

For mutations, the adapter first uses foreign keys declared in the Drizzle schema via `.references()` to identify
which table owns the FK and then falls back to primary-key inference. A relation without those schema declarations
that joins through alternate or shared-primary keys must declare the owner explicitly:

```ts
NestjsQueryDrizzleModule.forFeature(
  [
    {
      DTOClass: AccountDTO,
      tableName: 'account',
      relationOptions: {
        profiles: { foreignKeySide: 'target' }
      }
    }
  ],
  { dbToken: DRIZZLE_DB, relations }
)
```

## Limitations

- **PostgreSQL only.** MySQL and SQLite are not supported.
- **Single-column primary keys only.** `QueryService.findById` takes a scalar id, so composite primary keys cannot
  be represented. A table without a single-column primary key fails at application bootstrap.
- **A relation's predefined `where` is honoured, unless it was inherited from the reverse relation.** Drizzle
  applies such filters inside its relational query builder; the adapter reproduces them on the count, aggregate
  and relation-mutation paths, which build SQL directly, so all of them agree on which rows belong to the
  relation. The exception is a relation that declares neither `from` nor `to`: it inherits its join keys *and* its
  `where` from the reverse relation, and that filter stays scoped to the declaring table, which the aggregate
  queries never select from. Declare `from`/`to` explicitly on that side to give it a filter of its own.
- **Sorting by relation fields is not supported.** A relation field in a sorting expression is rejected as a bad
  request; sort by columns of the queried table instead. *Filtering* by relation fields works, exactly as deep as
  the generated schema exposes it (one level): the filter becomes a correlated `EXISTS` subquery, so a to-many
  relation never duplicates parent rows and `totalCount` stays exact. An empty relation filter (`{ subTasks: {} }`)
  carries no predicate and matches every row, matching `query-typeorm`.
- **Relations without FK metadata may need an ownership override.** This applies when both join columns are primary
  keys or neither is a primary key. Reads still work without the override; mutations require `foreignKeySide`.
- **Soft delete is not supported.** `withDeleted` is ignored because nothing is hidden. Delete operations with
  `useSoftDelete: true` are rejected before issuing SQL; they are never silently converted to permanent deletes.
- **No assembler conversion.** Rows are returned as-is, so `class-transformer` decorators on the DTO have no
  effect. Use an [Assembler](../../concepts/advanced/assemblers.mdx) if you need a conversion step.
- **Relation mutations are not transactional.** `setRelations` detaches the existing collection and then attaches
  the new one as separate statements.

## Example

A complete working application lives in
[`examples/drizzle`](https://github.com/tripss/nestjs-query/tree/master/examples/drizzle), covering all three
relation layouts along with filtering, sorting, paging and aggregation.

It also ships a [k6](https://grafana.com/docs/k6/latest/) load suite under
[`examples/drizzle/perf`](https://github.com/tripss/nestjs-query/tree/master/examples/drizzle/perf), which seeds a
realistic dataset and exercises the flat-query, relation, aggregate and mutation paths with latency thresholds:

```sh
yarn docker up -d postgres
yarn perf:drizzle
```
