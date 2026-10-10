import { FactoryProvider } from '@nestjs/common'
import { getQueryServiceToken } from '@ptc-org/nestjs-query-core'

import type { TablesRelationalConfig } from 'drizzle-orm'

import { DrizzleQueryService } from './services'
import { DrizzleDatabase, NestjsQueryDrizzleModelDefinition } from './typings'

function createDrizzleQueryServiceProvider<Entity>(
  model: NestjsQueryDrizzleModelDefinition<Entity>,
  dbToken: string | symbol,
  relations: TablesRelationalConfig
): FactoryProvider {
  return {
    provide: getQueryServiceToken(model.DTOClass),
    useFactory(db: DrizzleDatabase) {
      return new DrizzleQueryService(db, model.DTOClass, model.tableName, relations, model.relationOptions)
    },
    inject: [dbToken]
  }
}

export const createDrizzleQueryServiceProviders = (
  models: NestjsQueryDrizzleModelDefinition<unknown>[],
  dbToken: string | symbol,
  relations: TablesRelationalConfig
): FactoryProvider[] => models.map((model) => createDrizzleQueryServiceProvider(model, dbToken, relations))
