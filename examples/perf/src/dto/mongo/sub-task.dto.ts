import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableField, FilterableRelation, KeySet, ObjectId, QueryOptions } from '@ptc-org/nestjs-query-graphql'
import mongoose from 'mongoose'

import { TodoItemDTO } from './todo-item.dto'

@ObjectType('SubTask')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
@FilterableRelation('todoItem', () => TodoItemDTO, { nullable: true })
export class SubTaskDTO {
  @ObjectId()
  _id!: mongoose.Types.ObjectId

  @FilterableField(() => ID)
  id!: string

  @FilterableField()
  title!: string

  @FilterableField()
  completed!: boolean
}
