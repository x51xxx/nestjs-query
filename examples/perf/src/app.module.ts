import { ApolloDriver } from '@nestjs/apollo'
import { DynamicModule, Module } from '@nestjs/common'
import { GraphQLModule } from '@nestjs/graphql'

import { formatGraphqlError } from '../../helpers'
import { getAdapter } from './registry'

@Module({})
export class AppModule {
  /**
   * Builds the application for one persistence adapter. The GraphQL layer and DTOs are identical across adapters;
   * only the modules returned by `adapter.imports()` differ.
   */
  static forAdapter(name: string, schemaFile: string): DynamicModule {
    return {
      module: AppModule,
      imports: [
        GraphQLModule.forRoot({
          driver: ApolloDriver,
          autoSchemaFile: schemaFile,
          sortSchema: true,
          formatError: formatGraphqlError
        }),
        ...getAdapter(name).imports()
      ]
    }
  }
}
