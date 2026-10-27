import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';

/** Existing bookmarks continue to the independently hosted Relay application. */
export default function RelayPage() {
  const [params] = useSearchParams();
  const target = new URL('https://cobuild.110-lab.cn/relay/');
  target.searchParams.set('view', 'operator');
  const conversation = params.get('conversation');
  if (conversation && /^[\w-]{1,128}$/.test(conversation))
    target.searchParams.set('conversation', conversation);
  const destination = target.href;
  useEffect(() => {
    window.location.replace(destination);
  }, [destination]);
  return (
    <main className="flex min-h-screen items-center justify-center">
      <Button asChild>
        <a href={destination}>打开 Relay</a>
      </Button>
    </main>
  );
}
