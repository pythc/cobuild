import {SuiteCollaborationService} from './feishu/suite-collaboration.service';
import {SuiteCollaborationController} from './feishu/suite-collaboration.controller';
import {SpaceModule} from '../space/space.module';
import {LabIdentityService} from './feishu/lab-identity.service';
import {LabIdentityController} from './feishu/lab-identity.controller';
import { FeishuService } from './feishu/feishu.service';
import { FeishuController } from './feishu/feishu.controller';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';

@Module({
  imports: [TokenModule, WorkspaceModule, SpaceModule],
  controllers: [SuiteCollaborationController, AuthController, FeishuController, LabIdentityController],
  providers: [SuiteCollaborationService, AuthService, SignupService, JwtStrategy, FeishuService, LabIdentityService],
  exports: [SignupService],
})
export class AuthModule {}
