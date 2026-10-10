import { Module } from '@nestjs/common'
import { NestjsQueryDrizzleModule } from '@ptc-org/nestjs-query-drizzle'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'

import { DatabaseModule } from '../database.module'
import { DRIZZLE_DB, relations } from '../schema'
import { TodoItemDTO } from './dto/todo-item.dto'
import { TodoItemInputDTO } from './dto/todo-item-input.dto'
import { TodoItemUpdateDTO } from './dto/todo-item-update.dto'

@Module({
  imports: [
    NestjsQueryGraphQLModule.forFeature({
      imports: [
        NestjsQueryDrizzleModule.forFeature([{ DTOClass: TodoItemDTO, tableName: 'todoItem' }], {
          imports: [DatabaseModule],
          dbToken: DRIZZLE_DB,
          relations
        })
      ],
      resolvers: [
        {
          DTOClass: TodoItemDTO,
          // Drizzle tables are plain objects, so the DTO doubles as the entity: the adapter registers its
          // QueryService under this same class's token.
          EntityClass: TodoItemDTO,
          CreateDTOClass: TodoItemInputDTO,
          UpdateDTOClass: TodoItemUpdateDTO,
          enableAggregate: true
        }
      ]
    })
  ]
})
export class TodoItemModule {}
