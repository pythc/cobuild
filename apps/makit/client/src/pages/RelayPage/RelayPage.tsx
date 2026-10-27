import {suiteRuntime} from '@/lib/suite-runtime';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';

/** Existing bookmarks continue to the independently hosted Relay application. */
export default function RelayPage() {
  const [params] = useSearchParams();
  const disabled=suiteRuntime()?.relay===false;
  const target = new URL(disabled ? suiteRuntime()!.platform : 'https://cobuild.110-lab.cn/relay/');
  target.searchParams.set('view', 'operator');
  const conversation = params.get('conversation');
  if (conversation && /^[\w-]{1,128}$/.test(conversation))
    target.searchParams.set('conversation', conversation);
  const destination = target.href;
  useEffect(() => {
    if(!disabled)window.location.replace(destination);
  }, [destination,disabled]);
  if(disabled)return <main className="p-8">Relay 模块尚未启用，请返回工作台。</main>;
  return (
    <main className="flex min-h-screen items-center justify-center">
      <Button asChild>
        <a href={destination}>打开 Relay</a>
      </Button>
    </main>
  );
}
