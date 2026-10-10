/* eslint-disable max-classes-per-file -- one create/update input pair per DTO, kept together deliberately. */
import { Field, InputType } from '@nestjs/graphql'
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * Input types are shared by every adapter: they carry no primary key and no foreign key, so nothing here depends
 * on whether ids are integers or ObjectIds. Without explicit inputs nestjs-query would generate them from the DTO
 * and require `id` on create, which differs per adapter family.
 */
@InputType('CreateTodoItem')
export class CreateTodoItemInput {
  @IsString()
  @MaxLength(100)
  @Field()
  title!: string

  @IsBoolean()
  @IsOptional()
  @Field({ nullable: true })
  completed?: boolean

  @IsInt()
  @IsOptional()
  @Field({ nullable: true })
  priority?: number
}

@InputType('UpdateTodoItem')
export class UpdateTodoItemInput {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Field({ nullable: true })
  title?: string

  @IsBoolean()
  @IsOptional()
  @Field({ nullable: true })
  completed?: boolean

  @IsInt()
  @IsOptional()
  @Field({ nullable: true })
  priority?: number
}

@InputType('CreateSubTask')
export class CreateSubTaskInput {
  @IsString()
  @MaxLength(100)
  @Field()
  title!: string

  @IsBoolean()
  @IsOptional()
  @Field({ nullable: true })
  completed?: boolean
}

@InputType('UpdateSubTask')
export class UpdateSubTaskInput {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Field({ nullable: true })
  title?: string

  @IsBoolean()
  @IsOptional()
  @Field({ nullable: true })
  completed?: boolean
}

@InputType('CreateTag')
export class CreateTagInput {
  @IsString()
  @MaxLength(100)
  @Field()
  name!: string
}

@InputType('UpdateTag')
export class UpdateTagInput {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Field({ nullable: true })
  name?: string
}
