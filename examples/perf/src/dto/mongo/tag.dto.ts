import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableField, KeySet, ObjectId, QueryOptions } from '@ptc-org/nestjs-query-graphql'
import mongoose from 'mongoose'

@ObjectType('Tag')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
export class TagDTO {
  @ObjectId()
  _id!: mongoose.Types.ObjectId

  @FilterableField(() => ID)
  id!: string

  @FilterableField()
  name!: string
}
