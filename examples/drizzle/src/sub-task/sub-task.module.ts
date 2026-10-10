import { Module } from '@nestjs/common'
import { NestjsQueryDrizzleModule } from '@ptc-org/nestjs-query-drizzle'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'

import { DatabaseModule } from '../database.module'
import { DRIZZLE_DB, relations } from '../schema'
import { SubTaskDTO } from './dto/sub-task.dto'
import { SubTaskInputDTO } from './dto/sub-task-input.dto'

@Module({
  imports: [
    NestjsQueryGraphQLModule.forFeature({
      imports: [
        NestjsQueryDrizzleModule.forFeature([{ DTOClass: SubTaskDTO, tableName: 'subTask' }], {
          imports: [DatabaseModule],
          dbToken: DRIZZLE_DB,
          relations
        })
      ],
      resolvers: [
        {
          DTOClass: SubTaskDTO,
          // Drizzle tables are plain objects, so the DTO doubles as the entity: the adapter registers its
          // QueryService under this same class's token.
          EntityClass: SubTaskDTO,
          CreateDTOClass: SubTaskInputDTO,
          UpdateDTOClass: SubTaskInputDTO,
          enableAggregate: true
        }
      ]
    })
  ]
})
export class SubTaskModule {}
