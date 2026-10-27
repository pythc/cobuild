import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
export default function NotFound() {
  return <main className="mx-auto grid min-h-[60vh] max-w-xl place-content-center gap-5 p-8 text-center">
    <p className="text-sm font-medium text-muted-foreground">404</p>
    <h1 className="text-2xl font-semibold">页面不存在</h1>
    <p className="text-sm text-muted-foreground">链接可能已失效，请返回需求池查找。</p>
    <Button asChild><Link to="/requirements">返回需求池</Link></Button>
  </main>;
}
