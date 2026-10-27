import { Badge } from '@/components/ui/badge';
import { REQUIREMENT_TYPE_STYLES } from '@/lib/requirement-utils';
import { cn } from '@/lib/utils';

export default function RequirementTypeBadge({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const label: string = type === '未设置' || !type ? '需求' : type;
  return (
    <Badge
      variant="outline"
      className={cn(
        REQUIREMENT_TYPE_STYLES[label] || REQUIREMENT_TYPE_STYLES.需求,
        className,
      )}
    >
      {label}
    </Badge>
  );
}
