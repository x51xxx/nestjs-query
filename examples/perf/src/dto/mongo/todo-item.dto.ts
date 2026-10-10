import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableCursorConnection, FilterableField, KeySet, ObjectId, QueryOptions } from '@ptc-org/nestjs-query-graphql'
import mongoose from 'mongoose'

import { SubTaskDTO } from './sub-task.dto'
import { TagDTO } from './tag.dto'

/**
 * Mongo counterpart of `../sql/todo-item.dto.ts`. The `_id` property and the string `id` are the only differences;
 * the emitted GraphQL type is identical, so the same k6 queries run against every adapter.
 */
@ObjectType('TodoItem')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
@FilterableCursorConnection('subTasks', () => SubTaskDTO, { enableTotalCount: true })
@FilterableCursorConnection('tags', () => TagDTO, { enableTotalCount: true })
export class TodoItemDTO {
  @ObjectId()
  _id!: mongoose.Types.ObjectId

  @FilterableField(() => ID)
  id!: string

  @FilterableField()
  title!: string

  @FilterableField()
  completed!: boolean

  @FilterableField()
  priority!: number
}
