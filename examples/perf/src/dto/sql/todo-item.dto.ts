import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableCursorConnection, FilterableField, KeySet, QueryOptions } from '@ptc-org/nestjs-query-graphql'

import { SubTaskDTO } from './sub-task.dto'
import { TagDTO } from './tag.dto'

/**
 * The SQL-family DTO. Its mongo counterpart in `../mongo/todo-item.dto.ts` differs only in the extra `_id`
 * property and the TS type of `id`; both emit an identical GraphQL type, which the harness verifies by diffing the
 * generated schemas across adapters.
 */
@ObjectType('TodoItem')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
@FilterableCursorConnection('subTasks', () => SubTaskDTO, { enableTotalCount: true })
@FilterableCursorConnection('tags', () => TagDTO, { enableTotalCount: true })
export class TodoItemDTO {
  @FilterableField(() => ID)
  id!: number

  @FilterableField()
  title!: string

  @FilterableField()
  completed!: boolean

  @FilterableField()
  priority!: number
}
