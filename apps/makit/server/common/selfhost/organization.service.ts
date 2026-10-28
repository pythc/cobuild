import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DrizzleDatabaseManager } from './database';
import { FeishuService } from '../../modules/requirements/feishu.service';

@Injectable()
export class MakitOrganizationService {
  private expires = 0;
  private pending?: Promise<void>;
  private chatExpires = 0;
  private chats: Awaited<ReturnType<FeishuService['visibleChats']>> = [];
  constructor(private readonly database: DrizzleDatabaseManager, private readonly feishu: FeishuService) {}
  async refresh(): Promise<void> {
    if (process.env.COBUILD_IDENTITY_MODE!=='local' && this.expires > Date.now()) return;
    if (this.pending) return this.pending;
    this.pending = this.sync().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async sync() {
    const snapshot = await this.feishu.organizationSnapshot();
    if (!snapshot.members.length) throw new ServiceUnavailableException('通讯录未返回完整成员，保留已有快照');
    await this.database.client.begin(async (tx) => {
      for (const department of snapshot.departments) await tx`INSERT INTO makit_department(id,name,parent_id)
        VALUES(${department.open_department_id},${department.name},${department.parent_department_id})
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,parent_id=EXCLUDED.parent_id`;
      for (const member of snapshot.members) {
        const active = member.status?.is_activated === true && !member.status.is_resigned && !member.status.is_exited && !member.status.is_frozen;
        const changed = await tx`INSERT INTO makit_directory(employee_id,open_id,union_id,name,avatar_url,department_ids,active)
          VALUES(${member.user_id},${member.open_id},${member.union_id},${member.name},${member.avatar?.avatar_240 || ''},${tx.json(member.department_ids || [])},${active})
          ON CONFLICT(employee_id) DO UPDATE SET union_id=EXCLUDED.union_id,name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,
            department_ids=EXCLUDED.department_ids,active=EXCLUDED.active,updated_at=now()
          WHERE makit_directory.open_id=EXCLUDED.open_id RETURNING employee_id`;
        if (!changed.length) throw new ServiceUnavailableException('组织成员 ID 映射冲突，保留原快照');
      }
    });
    this.expires = Date.now() + 300000;
  }
  async visibleChats() {
    if(process.env.COBUILD_IDENTITY_MODE==='local')return [];
    if (this.chatExpires <= Date.now()) {
      this.chats = await this.feishu.visibleChats();
      this.chatExpires = Date.now() + 60000;
    }
    return this.chats;
  }
}
