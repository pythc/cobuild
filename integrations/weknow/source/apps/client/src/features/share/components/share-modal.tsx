import React, { useState } from "react";
import { Button, Popover, Text, Stack } from "@mantine/core";
import { IconLink, IconCheck } from "@tabler/icons-react";
export function ShareModal(_props: any) {
  const [copied, setCopied] = useState(false);
  return (
    <Popover width={280} position="bottom" withArrow>
      <Popover.Target>
        <Button
          variant="subtle"
          size="compact-sm"
          color="gray"
          leftSection={<IconLink size={18} />}
        >
          分享
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text size="sm">仅有文档访问权限的组织成员可打开此链接。</Text>
          <Button
            size="xs"
            leftSection={
              copied ? <IconCheck size={16} /> : <IconLink size={16} />
            }
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  window.location.origin + window.location.pathname,
                );
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "已复制" : "复制内部链接"}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
export default ShareModal;
