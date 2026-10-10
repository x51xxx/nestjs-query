import { Module, OnApplicationShutdown } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { DRIZZLE_DB, relations } from './schema'

/**
 * Drizzle has no official Nest module, so the app owns the connection and exposes the `db` instance under a DI
 * token. `NestjsQueryDrizzleModule.forFeature` is then pointed at that token.
 */
@Module({
  providers: [
    {
      provide: Pool,
      useFactory: () =>
        new Pool({
          host: process.env.DRIZZLE_PG_HOST ?? 'localhost',
          port: Number(process.env.DRIZZLE_PG_PORT ?? 5436),
          user: process.env.DRIZZLE_PG_USER ?? 'drizzle',
          database: process.env.DRIZZLE_PG_DATABASE ?? 'drizzle'
        })
    },
    {
      provide: DRIZZLE_DB,
      // Drizzle v1 takes an existing client as `{ client }`. Passing the pool positionally is the v0 API and
      // silently makes drizzle build its own default pool instead.
      useFactory: (pool: Pool) => drizzle({ client: pool, relations }),
      inject: [Pool]
    }
  ],
  exports: [DRIZZLE_DB, Pool]
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end()
  }
}
