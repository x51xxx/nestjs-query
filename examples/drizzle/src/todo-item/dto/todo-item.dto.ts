import { GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql'
import { FilterableCursorConnection, FilterableField, KeySet, QueryOptions } from '@ptc-org/nestjs-query-graphql'

import { SubTaskDTO } from '../../sub-task/dto/sub-task.dto'
import { TagDTO } from '../../tag/dto/tag.dto'

@ObjectType('TodoItem')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
// has-many: the foreign key lives on sub_task
@FilterableCursorConnection('subTasks', () => SubTaskDTO, {
  update: { enabled: true },
  remove: { enabled: true }
})
// has-many narrowed by the relation's own `where`: reads, counts, aggregates and the detach half of
// `setCompletedSubTasksOnTodoItem` all have to stay inside `completed = true`
@FilterableCursorConnection('completedSubTasks', () => SubTaskDTO, {
  enableAggregate: true,
  update: { enabled: true }
})
// many-to-many through the todo_item_tags junction table
@FilterableCursorConnection('tags', () => TagDTO, {
  update: { enabled: true },
  remove: { enabled: true }
})
export class TodoItemDTO {
  @FilterableField(() => ID)
  id!: number

  @FilterableField()
  title!: string

  @FilterableField()
  completed!: boolean

  @FilterableField()
  priority!: number

  @FilterableField(() => GraphQLISODateTime)
  created!: Date

  @FilterableField(() => GraphQLISODateTime)
  updated!: Date
}
