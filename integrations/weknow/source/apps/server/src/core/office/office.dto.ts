import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
export class DirectoryDto {
  @IsUUID() spaceId: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @IsUUID() parentPageId?: string;
}
export class CreateFileDto extends DirectoryDto {
  @IsString() @MaxLength(180) title: string;
  @IsIn(['folder', 'md', 'docx', 'xlsx', 'pptx']) type: string;
  @IsOptional() @IsIn(['file', 'office']) mode?: string;
}
export class OfficePageDto {
  @IsUUID() pageId: string;
}
export class FileVersionDto extends OfficePageDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
export class ConvertFileDto extends OfficePageDto {
  @IsIn(['pdf', 'docx', 'xlsx', 'pptx']) format: string;
  @IsOptional() @IsIn(['export', 'online-copy']) purpose?: string;
}
export class FileTaskDto {
  @IsUUID() taskId: string;
}
