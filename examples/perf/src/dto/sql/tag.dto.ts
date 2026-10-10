import { ID, ObjectType } from '@nestjs/graphql'
import { FilterableField, KeySet, QueryOptions } from '@ptc-org/nestjs-query-graphql'

@ObjectType('Tag')
@KeySet(['id'])
@QueryOptions({ enableTotalCount: true })
export class TagDTO {
  @FilterableField(() => ID)
  id!: number

  @FilterableField()
  name!: string
}
