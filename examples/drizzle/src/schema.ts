import { defineRelations } from 'drizzle-orm'
import { boolean, integer, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const todoItem = pgTable('todo_item', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  priority: integer('priority').notNull().default(0),
  created: timestamp('created').notNull().defaultNow(),
  updated: timestamp('updated').notNull().defaultNow()
})

export const subTask = pgTable('sub_task', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  completed: boolean('completed').notNull().default(false),
  todoItemId: integer('todo_item_id').references(() => todoItem.id)
})

export const tag = pgTable('tag', {
  id: serial('id').primaryKey(),
  name: text('name').notNull()
})

export const todoItemTags = pgTable(
  'todo_item_tags',
  {
    todoItemId: integer('todo_item_id')
      .notNull()
      .references(() => todoItem.id),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tag.id)
  },
  (t) => [primaryKey({ columns: [t.todoItemId, t.tagId] })]
)

export const schema = { todoItem, subTask, tag, todoItemTags }

/**
 * Exercises all three foreign-key layouts the adapter supports:
 * - `todoItem.subTasks` -- has-many, FK on the related table
 * - `subTask.todoItem` -- belongs-to, FK on the declaring table
 * - `todoItem.tags` / `tag.todoItems` -- many-to-many through a junction table
 * - `todoItem.completedSubTasks` -- has-many narrowed by a relation-level `where`
 */
export const relations = defineRelations(schema, (r) => ({
  todoItem: {
    subTasks: r.many.subTask({ from: r.todoItem.id, to: r.subTask.todoItemId }),
    completedSubTasks: r.many.subTask({
      from: r.todoItem.id,
      to: r.subTask.todoItemId,
      where: { completed: true }
    }),
    tags: r.many.tag({
      from: r.todoItem.id.through(r.todoItemTags.todoItemId),
      to: r.tag.id.through(r.todoItemTags.tagId)
    })
  },
  subTask: {
    todoItem: r.one.todoItem({ from: r.subTask.todoItemId, to: r.todoItem.id })
  },
  tag: {
    todoItems: r.many.todoItem({
      from: r.tag.id.through(r.todoItemTags.tagId),
      to: r.todoItem.id.through(r.todoItemTags.todoItemId)
    })
  }
}))

export const DRIZZLE_DB = 'DRIZZLE_DB'
