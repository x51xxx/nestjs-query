import { Field, InputType } from '@nestjs/graphql'
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator'

@InputType('TodoItemInput')
export class TodoItemInputDTO {
  @IsString()
  @MaxLength(50)
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
