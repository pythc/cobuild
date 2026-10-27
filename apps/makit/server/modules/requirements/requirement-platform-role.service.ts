import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import {
  AuthNPaasService,
  PlatformHttpClientService,
} from '@lark-apaas/fullstack-nestjs-core';
import { RequestContextService } from '@lark-apaas/nestjs-common';
import { FeishuService } from './feishu.service';

interface PlatformRoleResponse {
  data?: {
    roleList?: unknown;
  };
}

@Injectable()
export class RequirementPlatformRoleService {
  private readonly logger: Logger = new Logger(
    RequirementPlatformRoleService.name,
  );

  constructor(
    private readonly platformHttp: PlatformHttpClientService,
    private readonly authn: AuthNPaasService,
    private readonly requestContext: RequestContextService,
    @Optional() private readonly feishu?: FeishuService,
  ) {}

  private appId(value?: string): string {
    const appId: string =
      value?.trim() ||
      process.env.REQUIREMENT_PLATFORM_APP_ID?.trim() ||
      process.env.MIAODA_APP_ID?.trim() ||
      '';
    if (!appId || !/^[A-Za-z0-9_-]+$/u.test(appId)) {
      throw new ServiceUnavailableException('暂时无法确认当前平台权限');
    }
    return appId;
  }

  async currentRoles(userId: string, appId?: string): Promise<string[]> {
    const normalizedUserId: string = userId.trim();
    const normalizedAppId: string = this.appId(appId);
    if (!normalizedUserId || !normalizedAppId) {
      throw new ServiceUnavailableException('暂时无法确认当前平台权限');
    }

    const controller: AbortController = new AbortController();
    const timeout: ReturnType<typeof setTimeout> = setTimeout(
      (): void => controller.abort(),
      5_000,
    );
    try {
      if (process.env.MAKIT_STORAGE === 'postgres' && this.feishu) {
        const [employeeId] = await this.authn.getBatchLarkUserIds([normalizedUserId]);
        if (!employeeId) throw new Error('组织账号尚未启用');
        await this.feishu.refreshMakitPermissions(employeeId);
      }
      const response = await this.platformHttp.instance.post(
        `/app/${normalizedAppId}/inner/api/v1/permissions/roles`,
        { userID: normalizedUserId },
        {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          platformAuth: {
            customClaims: { user_id: normalizedUserId },
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`平台权限接口返回 ${response.status}`);
      }
      const payload: PlatformRoleResponse = JSON.parse(
        await response.text(),
      ) as PlatformRoleResponse;
      const roles: unknown = payload.data?.roleList;
      if (!Array.isArray(roles)) throw new Error('平台未返回有效角色数据');
      return [
        ...new Set(
          roles.filter((role: unknown): role is string =>
            Boolean(typeof role === 'string' && role.trim()),
          ),
        ),
      ];
    } catch (error) {
      this.logger.error(
        `刷新用户平台角色失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException('暂时无法确认当前平台权限');
    } finally {
      clearTimeout(timeout);
    }
  }

  async employeeId(userId: string, appId?: string): Promise<string> {
    const normalizedUserId: string = userId.trim();
    const normalizedAppId: string = this.appId(appId);
    if (!normalizedUserId) {
      throw new ServiceUnavailableException('暂时无法确认当前平台身份');
    }
    try {
      const [employeeId] = await this.requestContext.run(
        { appId: normalizedAppId, userId: normalizedUserId },
        (): Promise<(string | null)[]> =>
          this.authn.getBatchLarkUserIds([normalizedUserId]),
      );
      const normalizedEmployeeId: string = String(employeeId || '').trim();
      if (!normalizedEmployeeId) throw new Error('平台未返回飞书身份');
      return normalizedEmployeeId;
    } catch (error) {
      this.logger.error(
        `刷新用户平台身份失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException('暂时无法确认当前平台身份');
    }
  }
}
