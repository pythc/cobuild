import { IsBoolean, IsISO8601, IsUUID } from 'class-validator';

export class ResolveCommentDto {
  @IsUUID()
  commentId: string;

  @IsBoolean()
  resolved: boolean;

  @IsISO8601()
  expectedUpdatedAt: string;
}
