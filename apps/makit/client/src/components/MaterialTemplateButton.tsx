import { useState } from 'react';
import { FilePlus2 } from 'lucide-react';
import {
  materialTemplate,
  type MaterialTemplateKind,
} from '@shared/material-templates';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { plainText } from '@/lib/requirement-utils';

export default function MaterialTemplateButton({
  kind,
  value,
  onChange,
  html = true,
}: {
  kind: MaterialTemplateKind;
  value: string;
  onChange: (value: string) => void;
  html?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const apply = () => onChange(materialTemplate(kind, html));
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => {
          if (plainText(value).trim()) setConfirm(true);
          else apply();
        }}
      >
        <FilePlus2 className="size-3.5" />
        使用模板
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>替换当前编辑内容？</AlertDialogTitle>
            <AlertDialogDescription>
              模板只提供填写结构，不包含测试结果。替换仅影响当前草稿，保存后才生效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留内容</AlertDialogCancel>
            <AlertDialogAction onClick={apply}>使用模板</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
