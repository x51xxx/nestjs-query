import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableField, FilterableRelation, KeySet, QueryOptions } from '@ptc-org/nestjs-query-graphql'

import { TodoItemDTO } from './todo-item.dto'

@ObjectType('SubTask')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
@FilterableRelation('todoItem', () => TodoItemDTO, { nullable: true })
export class SubTaskDTO {
  @FilterableField(() => ID)
  id!: number

  @FilterableField()
  title!: string

  @FilterableField()
  completed!: boolean
}
