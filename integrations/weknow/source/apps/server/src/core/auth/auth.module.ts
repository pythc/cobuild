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
  imports: [TokenModule, WorkspaceModule],
  controllers: [AuthController, FeishuController, LabIdentityController],
  providers: [AuthService, SignupService, JwtStrategy, FeishuService, LabIdentityService],
  exports: [SignupService],
})
export class AuthModule {}
