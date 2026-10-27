import { useState } from 'react';
import { Brand } from '@/components/Brand';
import { axiosForBackend } from '@/lib/selfhost-http';
export default function LabConnectPage() {
  const ticket = new URLSearchParams(location.search).get('ticket'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function connect() {
    if (!ticket || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = (await axiosForBackend({
        url: '/api/workspace/identity/confirm',
        method: 'POST',
        data: { ticket },
      })) as {
        data: { encrypted: unknown; state: string; redirectUri: string };
      };
      const v = r.data,
        u = new URL(v.redirectUri);
      if (
        u.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
        u.pathname !== '/callback/110lab_requirements' ||
        u.search ||
        u.hash ||
        u.username ||
        u.password ||
        !/^[\w-]{43}$/.test(v.state)
      )
        throw new Error();
      // Only encrypted credentials travel through the browser. The private key
      // belongs to the originating desktop process and never leaves that process.
      const form = document.createElement('form');
      form.method = 'POST';
      form.target = '_top';
      form.action = u.href;
      for (const [name, value] of Object.entries({
        state: v.state,
        encrypted: JSON.stringify(v.encrypted),
      })) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
      setBusy(false);
    } catch {
      setError('连接未完成。请确认已使用同一飞书账号登录需求平台，再重试。');
      setBusy(false);
    }
  }
  return (
    <main
      style={{
        minHeight: '100svh',
        display: 'grid',
        placeItems: 'center',
        background: '#f6f8fc',
        padding: 24,
      }}
    >
      <section
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 36,
          border: '1px solid #e8edf6',
          borderRadius: 22,
          background: 'white',
          boxShadow: '0 20px 60px #22336608',
        }}
      >
        <Brand className="flex items-center gap-3" />
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: '32px 0 12px' }}>
          连接需求平台
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.8, color: '#7b879f' }}>
          确认后，连接会自动返回当前客户端。
        </p>
        {(!ticket || error) && (
          <p role="alert" style={{ color: '#a94a4a', fontSize: 14 }}>
            {error || '连接链接无效，请从插件重新连接。'}
          </p>
        )}
        <button
          disabled={!ticket || busy}
          onClick={() => void connect()}
          style={{
            width: '100%',
            height: 48,
            marginTop: 24,
            border: 0,
            borderRadius: 12,
            background: '#3459d9',
            color: 'white',
            fontSize: 15,
            cursor: 'pointer',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? '正在连接…' : '确认连接'}
        </button>
      </section>
    </main>
  );
}
