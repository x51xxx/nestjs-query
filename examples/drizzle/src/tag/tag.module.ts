import { Module } from '@nestjs/common'
import { NestjsQueryDrizzleModule } from '@ptc-org/nestjs-query-drizzle'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'

import { DatabaseModule } from '../database.module'
import { DRIZZLE_DB, relations } from '../schema'
import { TagDTO } from './dto/tag.dto'
import { TagInputDTO } from './dto/tag-input.dto'

@Module({
  imports: [
    NestjsQueryGraphQLModule.forFeature({
      imports: [
        NestjsQueryDrizzleModule.forFeature([{ DTOClass: TagDTO, tableName: 'tag' }], {
          imports: [DatabaseModule],
          dbToken: DRIZZLE_DB,
          relations
        })
      ],
      resolvers: [
        {
          DTOClass: TagDTO,
          // Drizzle tables are plain objects, so the DTO doubles as the entity: the adapter registers its
          // QueryService under this same class's token.
          EntityClass: TagDTO,
          CreateDTOClass: TagInputDTO,
          UpdateDTOClass: TagInputDTO,
          enableAggregate: true
        }
      ]
    })
  ]
})
export class TagModule {}
