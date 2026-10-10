import { Field, InputType } from '@nestjs/graphql'
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator'

@InputType('SubTaskInput')
export class SubTaskInputDTO {
  @IsString()
  @MaxLength(50)
  @Field()
  title!: string

  @IsString()
  @IsOptional()
  @Field({ nullable: true })
  description?: string

  @IsBoolean()
  @IsOptional()
  @Field({ nullable: true })
  completed?: boolean

  @IsInt()
  @IsOptional()
  @Field({ nullable: true })
  todoItemId?: number
}
