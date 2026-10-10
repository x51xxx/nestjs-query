import { Client } from 'pg'

import type { PoolConfig } from 'pg'

export const PERF_DATABASE = process.env.PERF_PG_DATABASE ?? 'perf'

/** Plain connection parameters, kept free of any ORM's option types so each adapter can shape them itself. */
export const postgresParams = {
  host: process.env.PERF_PG_HOST ?? 'localhost',
  port: Number(process.env.PERF_PG_PORT ?? 5436),
  username: process.env.PERF_PG_USER ?? 'nestjs_query',
  database: PERF_DATABASE
}

/** `pg`-flavoured variant for the drizzle adapter, which drives a `Pool` directly. */
export const postgresConnection = (): PoolConfig => ({
  host: postgresParams.host,
  port: postgresParams.port,
  user: postgresParams.username,
  database: postgresParams.database
})

/**
 * All SQL adapters share one database and run sequentially, each rebuilding the schema. The docker image only runs
 * its init scripts on first boot, so the database is created here instead.
 *
 * NOTE: unlike the two mongo adapters, the SQL adapters cannot reuse each other's seeded data -- sequelize names
 * its columns after model attributes (`todoItemId`) while drizzle and typeorm use snake_case (`todo_item_id`), so
 * every run rebuilds. That costs seconds even at large sizes; the mongo seeder, an order of magnitude slower, does
 * skip redundant work.
 */
export const ensurePerfDatabase = async (): Promise<void> => {
  const client = new Client({
    host: postgresParams.host,
    port: postgresParams.port,
    user: postgresParams.username,
    database: 'postgres'
  })

  await client.connect()
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [PERF_DATABASE])

    if (!rowCount) {
      await client.query(`CREATE DATABASE "${PERF_DATABASE}"`)
    }
  } finally {
    await client.end()
  }
}
