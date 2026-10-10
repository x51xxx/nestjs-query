import { Field, InputType } from '@nestjs/graphql'
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator'

@InputType('TodoItemUpdate')
export class TodoItemUpdateDTO {
  @IsString()
  @IsOptional()
  @MaxLength(50)
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
