import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class FeishuApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
  }
}

/** Fixed official origin; caller-supplied URLs and provider error text never enter logs. */
@Injectable()
export class FeishuApiService {
  private token?: { value: string; expires: number };
  private pendingToken?: Promise<string>;
  constructor(private config: ConfigService) {}
  get appId() {
    return this.config.get<string>('FEISHU_APP_ID', '');
  }
  get tenant() {
    return this.config.get<string>('FEISHU_TENANT_KEY', '');
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      const data = await this.request('/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.appId,
          app_secret: this.config.get('FEISHU_APP_SECRET'),
        }),
      });
      if (
        typeof data.tenant_access_token !== 'string' ||
        !Number.isFinite(data.expire) ||
        data.expire < 120
      )
        throw new FeishuApiError('invalid_token_response');
      this.token = {
        value: data.tenant_access_token,
        expires: Date.now() + (data.expire - 60) * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = undefined;
    }
  }

  async call(
    path: string,
    params: Record<string, string> = {},
    body?: any,
  ): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      try {
        const url = new URL('https://open.feishu.cn/open-apis' + path);
        for (const [key, value] of Object.entries(params))
          url.searchParams.set(key, value);
        return (
          await this.request(
            url.pathname + url.search,
            {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json; charset=utf-8',
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
            true,
          )
        ).data;
      } catch (e) {
        if (
          e instanceof FeishuApiError &&
          ['99991663', '99991668'].includes(e.code) &&
          attempt === 0
        ) {
          this.token = undefined;
          continue;
        }
        throw e;
      }
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    prefixed = false,
  ): Promise<any> {
    try {
      const response = await fetch(
        'https://open.feishu.cn' + (prefixed ? '' : '/open-apis') + path,
        { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) },
      );
      if (response.status === 429 || response.status >= 500)
        throw new FeishuApiError('http_' + response.status, true);
      const body = await response.json();
      if (body.code !== 0)
        throw new FeishuApiError(
          String(Number(body.code) || 'invalid_response'),
          [99991400, 230020, 230049].includes(body.code),
        );
      if (!response.ok) throw new FeishuApiError('http_' + response.status);
      return body;
    } catch (e) {
      if (e instanceof FeishuApiError) throw e;
      throw new FeishuApiError('network_error', true);
    }
  }

  async pages(
    path: string,
    params: Record<string, string>,
    field: string,
  ): Promise<any[]> {
    const items: any[] = [];
    const seen = new Set<string>();
    let token = '';
    for (let i = 0; i < 200; i++) {
      const data = await this.call(path, {
        ...params,
        ...(token ? { page_token: token } : {}),
      });
      if (
        !data ||
        typeof data.has_more !== 'boolean' ||
        (!Array.isArray(data[field]) &&
          !(data[field] === undefined && !data.has_more))
      )
        throw new FeishuApiError('invalid_page');
      items.push(...(data[field] || []));
      if (items.length > 10000) throw new FeishuApiError('directory_limit');
      if (!data.has_more) return items;
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
}
