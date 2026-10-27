import {useQuery} from '@tanstack/react-query';
import {getMemberAvatar} from '@/api';
import { UserWithAvatar } from '@/components/business-ui/user-display/user-with-avatar';
import type { PersonRef } from '@shared/api.interface';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export default function PersonStack({
  people,
  max = 3,
  showNames = false,
}: {
  people: PersonRef[];
  max?: number;
  showNames?: boolean;
}) {
  if (!people.length) {
    return <span className="text-xs text-muted-foreground">未分配</span>;
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex -space-x-1.5">
        {people.slice(0, max).map((person) => (
          <Tooltip key={person.id}>
            <TooltipTrigger asChild>
              <span className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-background bg-primary/10 text-[10px] font-semibold text-primary">
                <PersonAvatar person={person}/>
              </span>
            </TooltipTrigger>
            <TooltipContent>{person.name || '成员'}</TooltipContent>
          </Tooltip>
        ))}
        {people.length > max ? (
          <span className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-background bg-muted text-[10px] font-medium text-muted-foreground">
            +{people.length - max}
          </span>
        ) : null}
      </div>
      {showNames ? (
        <span className="truncate text-sm text-muted-foreground">
          {people.map((person) => person.name || '成员').join('、')}
        </span>
      ) : null}
    </div>
  );
}

function PersonAvatar({person}:{person:PersonRef}) {
  const avatar = useQuery({queryKey:['feishu-avatar',person.id],queryFn:()=>getMemberAvatar(person.id),
    enabled:!person.avatarUrl&&/^ou_[A-Za-z0-9_-]{5,128}$/.test(person.id),staleTime:300000,retry:false});
  return <UserWithAvatar data={{user_id:person.id,name:person.name,avatar:person.avatarUrl||avatar.data?.avatarUrl}} size="small" mode="plain" showLabel={false}/>;
}
