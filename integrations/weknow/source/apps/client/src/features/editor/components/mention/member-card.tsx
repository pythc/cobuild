import { Popover, Group, Text, Button, Stack } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { extractPageSlugId } from "@/lib";
import { CustomAvatar } from "@/components/ui/custom-avatar";
import api from "@/lib/api-client";

export function MemberCard({
  memberId,
  name,
  children,
  enabled = true,
}: {
  memberId: string;
  name: string;
  children: ReactNode;
  enabled?: boolean;
}) {
  const [opened, setOpened] = useState(false),
    [copied, setCopied] = useState(false);
  const { pageSlug } = useParams();
  const { data: page } = usePageQuery({
    pageId: enabled && opened ? extractPageSlugId(pageSlug) : null,
  });
  const query = useQuery({
    queryKey: ["mention-access", page?.id, memberId],
    enabled: opened && !!page?.id,
    retry: false,
    staleTime: 0,
    queryFn: async () =>
      (await api.post("/review/member", { pageId: page.id, memberId }))
        .data as any,
  });
  if (!enabled) return <>{children}</>;
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-start"
      width={280}
      shadow="sm"
      withArrow
    >
      <Popover.Target>
        <span
          role="button"
          tabIndex={0}
          aria-label={`查看${name}的文档权限`}
          onClick={() => setOpened((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpened((v) => !v);
            }
          }}
        >
          {children}
        </span>
      </Popover.Target>
      <Popover.Dropdown contentEditable={false}>
        <Stack gap="sm">
          <Group>
            <CustomAvatar
              name={query.data?.name || name}
              avatarUrl={query.data?.avatarUrl}
              size={32}
            />
            <Text fw={500} size="sm">
              {query.data?.name || name}
            </Text>
          </Group>
          <Text size="sm" c={query.data?.canView ? "teal" : "dimmed"}>
            {query.isError
              ? "暂时无法核对访问权限"
              : query.isPending
                ? "正在核对权限"
                : query.data?.canView
                  ? "可以查看此文档"
                  : "目前无法查看此文档"}
          </Text>
          {query.data && !query.data.canView && (
            <Text size="xs" c="dimmed">
              提及不会自动授予权限。请联系
              {query.data.owner?.name || "空间管理员"}
              调整文档与空间权限后，再通知对方。
            </Text>
          )}
          {query.data?.canView && (
            <Text size="xs" c="dimmed">
              提及通知沿用成员的通知设置；打开链接后定位到此人的首次提及。
            </Text>
          )}
          <Button
            size="xs"
            variant="light"
            onClick={async () => {
              try {
                const url = new URL(location.href);
                url.searchParams.set("mention", memberId);
                await navigator.clipboard.writeText(url.href);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "已复制" : "复制提及链接"}
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
