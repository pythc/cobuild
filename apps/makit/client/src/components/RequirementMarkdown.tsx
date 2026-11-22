import { Streamdown } from '@/components/ui/streamdown';
import { cn } from '@/lib/utils';

const markdownOptions = { allowDangerousHtml: false };

export default function RequirementMarkdown({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <Streamdown
      mode="static"
      controls={false}
      remarkRehypeOptions={markdownOptions}
      className={cn('prose-sm [overflow-wrap:anywhere]', className)}
    >
      {value}
    </Streamdown>
  );
}
