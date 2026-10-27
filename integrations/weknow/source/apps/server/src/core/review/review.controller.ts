import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  IsArray,
  ArrayMaxSize,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { OAuthScope } from '../../common/decorators/oauth-scope.decorator';
import { ReviewService } from './review.service';
class PageDto {
  @IsUUID() pageId: string;
}
class SuggestDto extends PageDto {
  @IsUUID() id: string;
  @IsObject() selection: any;
  @IsString() @MaxLength(8000) replacement: string;
}
class DecideDto {
  @IsUUID() id: string;
  @IsIn(['accepted', 'rejected']) decision: 'accepted' | 'rejected';
}
class CheckpointDto extends PageDto {
  @IsString() @MaxLength(65536) stateVector: string;
  @IsArray() @ArrayMaxSize(10000) deleteRanges: any[];
}
class MemberDto extends PageDto {
  @IsUUID() memberId: string;
}
@Controller('review')
@UseGuards(JwtAuthGuard)
export class ReviewController {
  constructor(private service: ReviewService) {}
  @Post('list')
  @HttpCode(200)
  @OAuthScope('read')
  list(
    @Body() d: PageDto,
    @AuthUser() user: any,
    @AuthWorkspace() workspace: any,
  ) {
    return this.service.list(d.pageId, { user, workspace });
  }
  @Post('create')
  @HttpCode(200)
  @OAuthScope('write')
  create(
    @Body() d: SuggestDto,
    @AuthUser() user: any,
    @AuthWorkspace() workspace: any,
  ) {
    return this.service.create(d, { user, workspace });
  }
  @Post('decide')
  @HttpCode(200)
  @OAuthScope('write')
  decide(
    @Body() d: DecideDto,
    @AuthUser() user: any,
    @AuthWorkspace() workspace: any,
  ) {
    return this.service.decide(d, { user, workspace });
  }
  @Post('checkpoint')
  @HttpCode(200)
  @OAuthScope('read')
  checkpoint(
    @Body() d: CheckpointDto,
    @AuthUser() user: any,
    @AuthWorkspace() workspace: any,
  ) {
    return this.service.checkpoint(d.pageId, d.stateVector, d.deleteRanges, {
      user,
      workspace,
    });
  }
  @Post('member')
  @HttpCode(200)
  @OAuthScope('read')
  member(
    @Body() d: MemberDto,
    @AuthUser() user: any,
    @AuthWorkspace() workspace: any,
  ) {
    return this.service.member(d.pageId, d.memberId, { user, workspace });
  }
}
