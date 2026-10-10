import { Field, InputType } from '@nestjs/graphql'
import { IsString, MaxLength } from 'class-validator'

@InputType('TagInput')
export class TagInputDTO {
  @IsString()
  @MaxLength(50)
  @Field()
  name!: string
}
