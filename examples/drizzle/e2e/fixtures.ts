import { sql } from 'drizzle-orm'

import type { DrizzleDatabase } from '@ptc-org/nestjs-query-drizzle'

/**
 * Drizzle has no runtime `synchronize` equivalent (schema changes go through drizzle-kit), so the e2e schema is
 * created explicitly. This runs once per suite -- per-test isolation is done by truncating, matching what the
 * other examples do via `executeTruncate`, rather than rebuilding the schema before every test.
 */
export const createSchema = async (db: DrizzleDatabase): Promise<void> => {
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
}

/** Resets the data between tests without touching the schema. */
export const refresh = async (db: DrizzleDatabase): Promise<void> => {
  await db.execute(sql`TRUNCATE todo_item, sub_task, tag, todo_item_tags RESTART IDENTITY CASCADE`)

  await db.execute(sql`
    INSERT INTO todo_item (title, completed, priority) VALUES
      ('Create Nest App', true, 0),
      ('Create Entity', false, 1),
      ('Create Entity Service', false, 2),
      ('Add Todo Item Resolver', false, 3),
      ('How to create item With Sub Tasks', false, 4)
  `)

  await db.execute(sql`INSERT INTO tag (name) VALUES ('Urgent'), ('Home'), ('Work'), ('Question'), ('Blocked')`)

  await db.execute(sql`
    INSERT INTO todo_item_tags (todo_item_id, tag_id) VALUES
      (1, 1), (1, 2),
      (2, 1), (2, 3),
      (3, 5), (3, 3),
      (4, 5), (4, 2),
      (5, 4), (5, 5)
  `)

  // Three sub tasks per todo item, minus the very last one -- mirrors the other examples' fixtures.
  await db.execute(sql`
    INSERT INTO sub_task (title, completed, todo_item_id)
    SELECT t.title || ' - Sub Task ' || s.n, s.n = 1, t.id
    FROM todo_item t
    CROSS JOIN generate_series(1, 3) AS s(n)
    ORDER BY t.id, s.n
  `)
  await db.execute(sql`DELETE FROM sub_task WHERE id = (SELECT max(id) FROM sub_task)`)
}
