import { ConflictException, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { OperationsSettings } from '@shared/operations-insights.interface';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import {
  DEFAULT_OPERATIONS_SETTINGS,
  validateOperationsSettings,
} from './operations-insights.model';

@Injectable()
export class OperationsSettingsService {
  constructor(private readonly database: ServiceRoleDatabaseExecutor) {}

  async get(): Promise<OperationsSettings> {
    const rows = await this.database.run((db) =>
      db.execute<{ revision: number; config_json: string }>(
        sql`SELECT revision, config_json FROM operations_setting WHERE key = 'runtime'`,
      ),
    );
    if (!rows[0]) return structuredClone(DEFAULT_OPERATIONS_SETTINGS);
    return validateOperationsSettings({
      ...JSON.parse(rows[0].config_json),
      revision: rows[0].revision,
    });
  }

  async save(
    input: OperationsSettings,
    actorUserId: string,
  ): Promise<OperationsSettings> {
    const settings = validateOperationsSettings(input);
    const previous = await this.get();
    if (
      previous.ai.pricing &&
      settings.ai.pricing?.version === previous.ai.pricing.version &&
      JSON.stringify(settings.ai.pricing) !==
        JSON.stringify(previous.ai.pricing)
    )
      throw new ConflictException(
        '价格发生变化时请填写新的价格版本，历史执行费用不会重算',
      );
    const config = JSON.stringify({ ai: settings.ai, alerts: settings.alerts });
    const rows = await this.database.run((db) =>
      settings.revision === 0
        ? db.execute<{ revision: number }>(
            sql`INSERT INTO operations_setting (key, revision, config_json, updated_by_user_id) VALUES ('runtime', 1, ${config}, ${actorUserId}) ON CONFLICT (key) DO NOTHING RETURNING revision`,
          )
        : db.execute<{ revision: number }>(
            sql`UPDATE operations_setting SET revision = revision + 1, config_json = ${config}, updated_by_user_id = ${actorUserId}, _updated_at = NOW() WHERE key = 'runtime' AND revision = ${settings.revision} RETURNING revision`,
          ),
    );
    if (!rows[0]) throw new ConflictException('设置已更新，请刷新后再保存');
    return { ...settings, revision: Number(rows[0].revision) };
  }
}
