import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SingleIterationSelectProps {
  value: string[];
  options: Array<{ value: string; label: string }>;
  onChange: (value: string[]) => void;
}

/** Legacy conflicts stay visible until the user explicitly chooses a destination. */
export default function SingleIterationSelect({
  value,
  options,
  onChange,
}: SingleIterationSelectProps) {
  const conflict = value.length > 1;
  const missing =
    value.length === 1 && !options.some((option) => option.value === value[0]);
  return (
    <div className="space-y-2">
      <Select
        value={conflict ? '__conflict__' : value[0] || '__unset__'}
        onValueChange={(id) => onChange(id === '__unset__' ? [] : [id])}
      >
        <SelectTrigger className="w-full" aria-label="所属迭代">
          <SelectValue placeholder="未设置" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__unset__">未设置</SelectItem>
          {conflict && (
            <SelectItem value="__conflict__" disabled>
              请选择唯一的所属迭代
            </SelectItem>
          )}
          {missing && (
            <SelectItem value={value[0]} disabled>
              {value[0]}（不可用）
            </SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {conflict && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          当前关联了多个迭代：
          {value
            .map(
              (id) =>
                options.find((option) => option.value === id)?.label || id,
            )
            .join('、')}
          。请选择保留的迭代后保存。
        </p>
      )}
    </div>
  );
}
