import { sql } from 'drizzle-orm'

import type { DrizzleDatabase } from '@ptc-org/nestjs-query-drizzle'

export interface SeedSizes {
  todoItems: number
  subTasksPerItem: number
  tags: number
  tagsPerItem: number
}

export const DEFAULT_SIZES: SeedSizes = {
  todoItems: 5_000,
  subTasksPerItem: 3,
  tags: 50,
  tagsPerItem: 3
}

/**
 * Creates the perf schema.
 *
 * The foreign key columns are indexed on purpose. Without them the relation scenarios degrade into a sequential
 * scan per parent, which measures the missing index rather than the adapter's relation-loading strategy -- see
 * `README.md`. Note `todo_item_tags`' composite primary key already covers `(todo_item_id, tag_id)`, so only the
 * reverse direction (`tag_id`) needs its own index.
 */
export const createPerfSchema = async (db: DrizzleDatabase): Promise<void> => {
  await db.execute(sql`DROP TABLE IF EXISTS todo_item_tags, sub_task, tag, todo_item CASCADE`)

  await db.execute(sql`
    CREATE TABLE todo_item (
      id serial PRIMARY KEY,
      title text NOT NULL,
      completed boolean NOT NULL DEFAULT false,
      priority integer NOT NULL DEFAULT 0,
      created timestamp NOT NULL DEFAULT now(),
      updated timestamp NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE TABLE sub_task (
      id serial PRIMARY KEY,
      title text NOT NULL,
      description text,
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
  // The read scenarios filter on `completed` and `priority` together. Indexing `priority` alone leaves `completed`
  // to be rechecked from the heap, which is what dominates a COUNT at scale -- equality column first so the range
  // column remains usable.
  await db.execute(sql`CREATE INDEX todo_item_completed_priority_idx ON todo_item (completed, priority)`)
}

/**
 * Populates the schema entirely through raw SQL. Seeding deliberately bypasses the adapter: routing it through
 * `createMany` would fold the very code path under test into setup time and hide the signal.
 */
export const seed = async (db: DrizzleDatabase, sizes: SeedSizes = DEFAULT_SIZES): Promise<void> => {
  const { todoItems, subTasksPerItem, tags, tagsPerItem } = sizes

  await db.execute(sql`
    INSERT INTO todo_item (title, completed, priority)
    SELECT 'Todo Item ' || n, n % 4 = 0, n % 10
    FROM generate_series(1, ${todoItems}) AS n
  `)

  await db.execute(sql`
    INSERT INTO tag (name)
    SELECT 'Tag ' || n FROM generate_series(1, ${tags}) AS n
  `)

  await db.execute(sql`
    INSERT INTO sub_task (title, completed, todo_item_id)
    SELECT t.title || ' - Sub Task ' || s.n, s.n = 1, t.id
    FROM todo_item t
    CROSS JOIN generate_series(1, ${subTasksPerItem}) AS s(n)
  `)

  // Deterministic spread of tags across items, avoiding duplicates against the composite primary key.
  await db.execute(sql`
    INSERT INTO todo_item_tags (todo_item_id, tag_id)
    SELECT t.id, 1 + ((t.id * 7 + s.n * 13) % ${tags})
    FROM todo_item t
    CROSS JOIN generate_series(1, ${tagsPerItem}) AS s(n)
    ON CONFLICT DO NOTHING
  `)

  // VACUUM populates the visibility map, without which Postgres cannot use an index-only scan and every count
  // falls back to reading the heap.
  await db.execute(sql`VACUUM (ANALYZE) todo_item`)
  await db.execute(sql`ANALYZE sub_task, tag, todo_item_tags`)
}
