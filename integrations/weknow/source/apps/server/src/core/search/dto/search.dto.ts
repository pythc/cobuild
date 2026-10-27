import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class SearchDTO {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  query?: string;

  @IsOptional()
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsString()
  shareId?: string;

  @IsOptional()
  @IsUUID()
  creatorId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  labelIds?: string[];

  @IsOptional()
  @IsBoolean()
  titleOnly?: boolean;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(0)
  @Max(10000)
  offset?: number;
}

export class SearchShareDTO extends SearchDTO {
  @IsNotEmpty()
  @IsString()
  shareId: string;

  @IsOptional()
  @IsUUID()
  spaceId: string;
}

export class SearchPublicSpaceDTO extends SearchDTO {
  @IsNotEmpty()
  @IsString()
  spaceSlug: string;
}

export class SearchSuggestionDTO {
  @IsString()
  query: string;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  includeGroups?: boolean;

  @IsOptional()
  @IsBoolean()
  includePages?: boolean;

  @IsOptional()
  @IsString()
  spaceId?: string;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
