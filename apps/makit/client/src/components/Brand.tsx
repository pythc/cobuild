import { APP_NAME, BRAND_ICON_URL } from '@/lib/brand';
import { Image } from '@/components/ui/image';

interface BrandProps {
  className?: string;
}

export function Brand({ className }: BrandProps) {
  return (
    <div className={className} aria-label={`${APP_NAME} 需求平台`}>
      <Image
        src={BRAND_ICON_URL}
        alt=""
        width={36}
        height={36}
        sizes="36px"
        loading="eager"
        className="h-9 w-9 shrink-0 bg-none object-contain"
      />
      <span className="text-2xl font-semibold tracking-tight text-foreground">
        {APP_NAME}
      </span>
    </div>
  );
}
