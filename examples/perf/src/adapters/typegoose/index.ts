/* Entity classes reference each other in both directions -- that is how these ORMs express relations,
   and the lazy `() => Entity` thunks make the ordering irrelevant at runtime. */
/* eslint-disable @typescript-eslint/no-use-before-define */
import { getConnectionToken, TypegooseModule } from '@m8a/nestjs-typegoose'
import { INestApplication } from '@nestjs/common'
import { NestjsQueryGraphQLModule, ObjectId } from '@ptc-org/nestjs-query-graphql'
import { NestjsQueryTypegooseModule } from '@ptc-org/nestjs-query-typegoose'
import { modelOptions, Prop, Ref } from '@typegoose/typegoose'
import { Base } from '@typegoose/typegoose/lib/defaultClasses'
import { Connection, Types } from 'mongoose'

import { NestImport, PerfAdapter, SeedSizes } from '../../adapter'
import { SubTaskDTO, TagDTO, TodoItemDTO } from '../../dto/mongo'
import { RESOLVER_SPECS } from '../../dto/resolvers'
import { MONGO_URI, seedMongo } from '../mongo.seed'

@modelOptions({ schemaOptions: { collection: 'tag', toObject: { virtuals: true } } })
export class TagEntity implements Base {
  @ObjectId()
  _id!: Types.ObjectId

  id!: string

  @Prop({ required: true })
  name!: string
}

@modelOptions({ schemaOptions: { collection: 'todo_item', toObject: { virtuals: true } } })
export class TodoItemEntity implements Base {
  @ObjectId()
  _id!: Types.ObjectId

  id!: string

  @Prop({ required: true })
  title!: string

  @Prop({ required: true, default: false })
  completed!: boolean

  @Prop({ required: true, default: 0 })
  priority!: number

  // Mongo has no junction table: the many-to-many is an array of references on the document itself.
  @Prop({ ref: () => TagEntity, default: [] })
  tags!: Ref<TagEntity>[]

  // Inverse of SubTaskEntity.todoItem, declared as a virtual populate so nestjs-query can resolve it.
  @Prop({ ref: () => SubTaskEntity, foreignField: 'todoItem', localField: '_id' })
  subTasks?: Ref<SubTaskEntity>[]
}

@modelOptions({ schemaOptions: { collection: 'sub_task', toObject: { virtuals: true } } })
export class SubTaskEntity implements Base {
  @ObjectId()
  _id!: Types.ObjectId

  id!: string

  @Prop({ required: true })
  title!: string

  @Prop({ required: true, default: false })
  completed!: boolean

  @ObjectId()
  @Prop({ ref: () => TodoItemEntity, index: true })
  todoItem?: Ref<TodoItemEntity>
}

const ENTITIES = { todoItem: TodoItemEntity, subTask: SubTaskEntity, tag: TagEntity }
const DTOS = { todoItem: TodoItemDTO, subTask: SubTaskDTO, tag: TagDTO }

const features = (): NestImport[] =>
  RESOLVER_SPECS.map(({ key, CreateDTOClass, UpdateDTOClass }) =>
    NestjsQueryGraphQLModule.forFeature({
      imports: [NestjsQueryTypegooseModule.forFeature([ENTITIES[key]])],
      resolvers: [
        {
          DTOClass: DTOS[key] as never,
          EntityClass: ENTITIES[key] as never,
          CreateDTOClass,
          UpdateDTOClass,
          enableAggregate: true
        }
      ]
    })
  )

export const typegooseAdapter: PerfAdapter = {
  name: 'typegoose',
  backend: 'mongo',

  imports: (): NestImport[] => [TypegooseModule.forRoot(MONGO_URI), ...features()],

  async seed(app: INestApplication, sizes: SeedSizes): Promise<void> {
    await seedMongo(app.get<Connection>(getConnectionToken()), sizes)
  }
}
