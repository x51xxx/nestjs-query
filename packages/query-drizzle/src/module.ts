import { DynamicModule } from '@nestjs/common'

import type { ModuleMetadata } from '@nestjs/common'
import type { TablesRelationalConfig } from 'drizzle-orm'

import { createDrizzleQueryServiceProviders } from './providers'
import { NestjsQueryDrizzleModelDefinition } from './typings'

export interface NestjsQueryDrizzleModuleOpts {
  /** Modules that provide `dbToken`; use this instead of requiring the database module to be global. */
  imports?: ModuleMetadata['imports']
  /**
   * The Nest DI token that resolves to the app's Drizzle `db` instance (there is no official Nest/Drizzle module
   * to wrap the way `@nestjs/typeorm`/`@nestjs/mongoose` are for the other adapters -- the app is expected to
   * provide its own `db` under this token).
   */
  dbToken: string | symbol
  /**
   * The full output of `defineRelations()` for the app's schema. Passed once because a single DTO's relations can
   * point at tables owned by other DTOs, so resolving them requires the whole config, not just this DTO's table.
   */
  relations: TablesRelationalConfig
}

export class NestjsQueryDrizzleModule {
  static forFeature(models: NestjsQueryDrizzleModelDefinition<unknown>[], opts: NestjsQueryDrizzleModuleOpts): DynamicModule {
    const queryServiceProviders = createDrizzleQueryServiceProviders(models, opts.dbToken, opts.relations)

    return {
      module: NestjsQueryDrizzleModule,
      imports: opts.imports,
      providers: [...queryServiceProviders],
      exports: [...queryServiceProviders]
    }
  }
}
