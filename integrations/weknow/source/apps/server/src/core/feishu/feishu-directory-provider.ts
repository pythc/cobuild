import { Injectable } from '@nestjs/common';
import {
  DirectoryDepartment,
  loadDepartmentGroups,
} from './feishu-department-provider';
import { FeishuApiError, FeishuApiService } from './feishu-api.service';
import {
  DirectoryStatus,
  memberStatus,
  safeFeishuAvatar,
} from './feishu-directory-policy';

export interface DirectoryMember {
  subject: string;
  name: string;
  avatarUrl: string | null;
  status: DirectoryStatus;
}
export interface DirectorySnapshot {
  startedAt: Date;
  members: DirectoryMember[];
  departments?: DirectoryDepartment[];
}

@Injectable()
export class FeishuDirectoryProvider {
  constructor(private api: FeishuApiService) {}

  async snapshot(
    opts: { includeDepartments?: boolean } = {},
  ): Promise<DirectorySnapshot> {
    const startedAt = new Date();
    const visibility = await this.visibility();
    const users = new Map<string, any>();
    const departments = new Map<string, string[]>();
    const groups = new Map<string, string[]>();
    const loadUser = async (subject: string) => {
      if (users.has(subject)) return;
      const data = await this.api.call(
        '/contact/v3/users/' + encodeURIComponent(subject),
        { user_id_type: 'open_id', department_id_type: 'department_id' },
      );
      if (!data?.user || data.user.open_id !== subject)
        throw new FeishuApiError('invalid_member');
      users.set(subject, data.user);
    };
    const expandDepartment = async (id: string): Promise<string[]> => {
      if (departments.has(id)) return departments.get(id)!;
      const children = await this.api.pages(
        '/contact/v3/departments/' + encodeURIComponent(id) + '/children',
        {
          department_id_type: 'department_id',
          fetch_child: 'true',
          page_size: '50',
        },
        'items',
      );
      const ids = new Set([
        id,
        ...children.map((d) => this.id(d.department_id)),
      ]);
      const members = new Set<string>();
      for (const department of ids) {
        const items = await this.api.pages(
          '/contact/v3/users/find_by_department',
          {
            department_id: department,
            department_id_type: 'department_id',
            user_id_type: 'open_id',
            page_size: '50',
          },
          'items',
        );
        for (const user of items) {
          const subject = this.id(user.open_id);
          users.set(subject, user);
          members.add(subject);
        }
      }
      const result = [...members];
      departments.set(id, result);
      return result;
    };
    const expandGroup = async (id: string): Promise<string[]> => {
      if (groups.has(id)) return groups.get(id)!;
      const members = new Set<string>();
      for (const type of ['user', 'department']) {
        const items = await this.api.pages(
          '/contact/v3/group/' + encodeURIComponent(id) + '/member/simplelist',
          {
            member_type: type,
            member_id_type: type === 'user' ? 'open_id' : 'department_id',
            page_size: '100',
          },
          'memberlist',
        );
        for (const item of items) {
          if (item.member_type !== type)
            throw new FeishuApiError('invalid_group_member');
          const memberId = this.id(item.member_id);
          if (type === 'user') {
            await loadUser(memberId);
            members.add(memberId);
          } else
            for (const subject of await expandDepartment(memberId))
              members.add(subject);
        }
      }
      const result = [...members];
      groups.set(id, result);
      return result;
    };
    const allowed = new Set<string>();
    const excluded = new Set<string>();
    if (visibility.is_visible_to_all === 1) {
      // All-member scopes can be returned as root "0" OR an enumerated set
      // of departments plus individual members. Consume every authorized page.
      const scope = await this.contactScope();
      for (const id of scope.users) {
        await loadUser(id);
        allowed.add(id);
      }
      for (const id of scope.departments)
        for (const subject of await expandDepartment(id)) allowed.add(subject);
      for (const id of scope.groups)
        for (const subject of await expandGroup(id)) allowed.add(subject);
    }
    for (const [prefix, target] of [
      ['', allowed],
      ['invisible_', excluded],
    ] as const) {
      for (const user of visibility[prefix + 'users']) {
        const id = this.id(user.open_id);
        await loadUser(id);
        target.add(id);
      }
      for (const dept of visibility[prefix + 'departments'])
        for (const id of await expandDepartment(this.id(dept.id)))
          target.add(id);
      for (const group of visibility[prefix + 'groups'])
        for (const id of await expandGroup(this.id(group.id))) target.add(id);
    }
    if (users.size > 10000) throw new FeishuApiError('directory_limit');
    const members: DirectoryMember[] = [];
    for (const subject of allowed) {
      if (excluded.has(subject)) continue;
      const user = users.get(subject);
      if (!user || typeof user.name !== 'string' || !user.name.trim())
        throw new FeishuApiError('invalid_member_name');
      members.push({
        subject,
        name: user.name.trim().slice(0, 50),
        avatarUrl: safeFeishuAvatar(
          user.avatar?.avatar_240 || user.avatar?.avatar_72,
        ),
        status: memberStatus(user.status),
      });
    }
    const departmentGroups = opts.includeDepartments
      ? await loadDepartmentGroups(
          this.api,
          new Set(
            members
              .filter((member) => member.status === 'active')
              .map((member) => member.subject),
          ),
        )
      : undefined;
    return { startedAt, members, departments: departmentGroups };
  }

  private id(value: any): string {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 256 ||
      /[\x00-\x20]/.test(value)
    )
      throw new FeishuApiError('invalid_directory_id');
    return value;
  }
  private async contactScope() {
    const result = {
      users: new Set<string>(),
      departments: new Set<string>(),
      groups: new Set<string>(),
    };
    const seen = new Set<string>();
    let token = '';
    for (let i = 0; i < 200; i++) {
      const data = await this.api.call('/contact/v3/scopes', {
        user_id_type: 'open_id',
        department_id_type: 'department_id',
        page_size: '100',
        ...(token ? { page_token: token } : {}),
      });
      if (!data || typeof data.has_more !== 'boolean')
        throw new FeishuApiError('invalid_contact_scope');
      for (const [field, key] of [
        ['user_ids', 'users'],
        ['department_ids', 'departments'],
        ['group_ids', 'groups'],
      ] as const) {
        if (data[field] !== undefined && !Array.isArray(data[field]))
          throw new FeishuApiError('invalid_contact_scope');
        for (const id of data[field] || []) result[key].add(this.id(id));
      }
      if (
        result.users.size + result.departments.size + result.groups.size >
        10000
      )
        throw new FeishuApiError('directory_limit');
      if (!data.has_more) return result;
      if (
        typeof data.page_token !== 'string' ||
        !data.page_token ||
        seen.has(data.page_token)
      )
        throw new FeishuApiError('invalid_pagination');
      token = data.page_token;
      seen.add(token);
    }
    throw new FeishuApiError('directory_limit');
  }
  private async visibility() {
    let result: any;
    let token = '';
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const data = await this.api.call('/application/v2/app/visibility', {
        app_id: this.api.appId,
        user_page_size: '1000',
        ...(token ? { user_page_token: token } : {}),
      });
      if (
        !data ||
        ![0, 1].includes(data.is_visible_to_all) ||
        ![0, 1].includes(data.has_more_users)
      )
        throw new FeishuApiError('invalid_visibility');
      if (data.has_more_users && !Array.isArray(data.users))
        throw new FeishuApiError('invalid_visibility');
      for (const field of [
        'users',
        'departments',
        'groups',
        'invisible_users',
        'invisible_departments',
        'invisible_groups',
      ])
        if (data[field] === undefined) data[field] = [];
        else if (!Array.isArray(data[field]))
          throw new FeishuApiError('invalid_visibility');
      if (!result) result = { ...data, users: [...data.users] };
      else {
        for (const field of [
          'departments',
          'groups',
          'invisible_users',
          'invisible_departments',
          'invisible_groups',
          'is_visible_to_all',
        ]) {
          if (JSON.stringify(result[field]) !== JSON.stringify(data[field]))
            throw new FeishuApiError('visibility_changed_during_sync', true);
        }
        result.users.push(...data.users);
      }
      if (result.users.length > 10000)
        throw new FeishuApiError('directory_limit');
      if (!data.has_more_users) return result;
      if (
        typeof data.user_page_token !== 'string' ||
        !data.user_page_token ||
        seen.has(data.user_page_token)
      )
        throw new FeishuApiError('invalid_pagination');
      token = data.user_page_token;
      seen.add(token);
    }
    throw new FeishuApiError('directory_limit');
  }
}
