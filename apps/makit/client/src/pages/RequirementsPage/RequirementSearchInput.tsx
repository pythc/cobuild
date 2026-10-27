import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

interface RequirementSearchInputProps {
  value: string;
  onSearch: (value: string) => void;
}

/** Keep unfinished IME input local; only committed text updates the URL/filter. */
export function RequirementSearchInput({
  value,
  onSearch,
}: RequirementSearchInputProps) {
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  useEffect(() => {
    if (!composing.current) setDraft(value);
  }, [value]);

  return (
    <Input
      className="h-10 pl-9"
      aria-label="搜索需求"
      value={draft}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        setDraft(event.currentTarget.value);
        onSearch(event.currentTarget.value);
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        if (!composing.current) onSearch(event.currentTarget.value);
      }}
      placeholder="搜索标题、编号、分支、项目、迭代或成员"
    />
  );
}
