import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableField, FilterableRelation, KeySet, QueryOptions } from '@ptc-org/nestjs-query-graphql'

import { TodoItemDTO } from '../../todo-item/dto/todo-item.dto'

@ObjectType('SubTask')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
// belongs-to: the foreign key lives on sub_task itself
@FilterableRelation('todoItem', () => TodoItemDTO, { update: { enabled: true } })
export class SubTaskDTO {
  @FilterableField(() => ID)
  id!: number

  @FilterableField()
  title!: string

  @FilterableField({ nullable: true })
  description?: string

  @FilterableField()
  completed!: boolean

  @FilterableField({ nullable: true })
  todoItemId?: number
}
