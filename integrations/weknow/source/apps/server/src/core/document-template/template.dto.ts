import {
  IsString,
  IsUUID,
  IsOptional,
  MaxLength,
  MinLength,
  IsIn,
  IsISO8601,
} from 'class-validator';
export class TemplateIdDto {
  @IsString() @MaxLength(100) id: string;
}
export class SaveTemplateDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MinLength(1) @MaxLength(180) title: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(50) category?: string;
  @IsString() @MinLength(1) @MaxLength(1000000) content: string;
  @IsOptional() @IsIn(['markdown', 'html']) format?: 'markdown' | 'html';
  @IsOptional() @IsISO8601() expectedUpdatedAt?: string;
}
export class ApplyTemplateDto extends TemplateIdDto {
  @IsUUID() spaceId: string;
  @IsOptional() @IsUUID() parentPageId?: string;
  @IsOptional() @IsString() @MaxLength(180) title?: string;
}
export class DeleteTemplateDto extends TemplateIdDto {
  @IsISO8601() expectedUpdatedAt: string;
}
