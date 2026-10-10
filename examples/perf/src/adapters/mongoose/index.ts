/* Entity classes reference each other in both directions -- that is how these ORMs express relations,
   and the lazy `() => Entity` thunks make the ordering irrelevant at runtime. */
/* eslint-disable @typescript-eslint/no-use-before-define */
import { INestApplication } from '@nestjs/common'
import { getConnectionToken, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { NestjsQueryGraphQLModule } from '@ptc-org/nestjs-query-graphql'
import { NestjsQueryMongooseModule } from '@ptc-org/nestjs-query-mongoose'
import mongoose, { Connection, Document, SchemaTypes, Types } from 'mongoose'

import { NestImport, PerfAdapter, SeedSizes } from '../../adapter'
import { SubTaskDTO, TagDTO, TodoItemDTO } from '../../dto/mongo'
import { RESOLVER_SPECS } from '../../dto/resolvers'
import { MONGO_URI, seedMongo } from '../mongo.seed'

@Schema({ collection: 'todo_item' })
export class TodoItemEntity extends Document {
  _id!: mongoose.Types.ObjectId

  @Prop({ required: true })
  title!: string

  @Prop({ required: true, default: false })
  completed!: boolean

  @Prop({ required: true, default: 0 })
  priority!: number

  // Mongo has no junction table: the many-to-many is an array of references on the document itself.
  @Prop([{ type: SchemaTypes.ObjectId, ref: 'TagEntity' }])
  tags!: Types.ObjectId[]
}

@Schema({ collection: 'sub_task' })
export class SubTaskEntity extends Document {
  _id!: mongoose.Types.ObjectId

  @Prop({ required: true })
  title!: string

  @Prop({ required: true, default: false })
  completed!: boolean

  @Prop({ type: SchemaTypes.ObjectId, ref: 'TodoItemEntity', index: true })
  todoItem?: Types.ObjectId
}

@Schema({ collection: 'tag' })
export class TagEntity extends Document {
  _id!: mongoose.Types.ObjectId

  @Prop({ required: true })
  name!: string
}

export const TodoItemEntitySchema = SchemaFactory.createForClass(TodoItemEntity)
export const SubTaskEntitySchema = SchemaFactory.createForClass(SubTaskEntity)
export const TagEntitySchema = SchemaFactory.createForClass(TagEntity)

// `subTasks` is the inverse of SubTaskEntity.todoItem, exposed as a virtual so nestjs-query can resolve it.
TodoItemEntitySchema.virtual('subTasks', {
  ref: 'SubTaskEntity',
  localField: '_id',
  foreignField: 'todoItem'
})

const ENTITIES = {
  todoItem: { document: TodoItemEntity, schema: TodoItemEntitySchema },
  subTask: { document: SubTaskEntity, schema: SubTaskEntitySchema },
  tag: { document: TagEntity, schema: TagEntitySchema }
}
const DTOS = { todoItem: TodoItemDTO, subTask: SubTaskDTO, tag: TagDTO }

const features = (): NestImport[] =>
  RESOLVER_SPECS.map(({ key, CreateDTOClass, UpdateDTOClass }) => {
    const { document, schema } = ENTITIES[key]

    return NestjsQueryGraphQLModule.forFeature({
      imports: [NestjsQueryMongooseModule.forFeature([{ document, name: document.name, schema }])],
      resolvers: [
        {
          DTOClass: DTOS[key] as never,
          EntityClass: document as never,
          CreateDTOClass,
          UpdateDTOClass,
          enableAggregate: true
        }
      ]
    })
  })

export const mongooseAdapter: PerfAdapter = {
  name: 'mongoose',
  backend: 'mongo',

  imports: (): NestImport[] => [MongooseModule.forRoot(MONGO_URI), ...features()],

  async seed(app: INestApplication, sizes: SeedSizes): Promise<void> {
    await seedMongo(app.get<Connection>(getConnectionToken()), sizes)
  }
}
