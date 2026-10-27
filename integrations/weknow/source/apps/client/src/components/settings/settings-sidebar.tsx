import React from "react";
import { Link, useLocation } from "react-router-dom";
import { ScrollArea, Text, UnstyledButton } from "@mantine/core";
import {
  IconUser,
  IconBrush,
  IconSettings,
  IconUsers,
  IconUsersGroup,
  IconLayoutGrid,
  IconBrandOpenSource,
  IconLock,
  IconArrowLeft,
} from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import useUserRole from "@/hooks/use-user-role";
import { mobileSidebarAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar";

type Entry = { label: string; path: string; icon: typeof IconUser };
export default function SettingsSidebar() {
  const { isAdmin } = useUserRole();
  const { pathname } = useLocation();
  const mobileOpened = useAtomValue(mobileSidebarAtom);
  const toggleMobile = useToggleSidebar(mobileSidebarAtom);
  const onNavigate = () => {
    if (mobileOpened) toggleMobile();
  };
  const account: Entry[] = [
    { label: "个人信息", path: "/settings/account/profile", icon: IconUser },
    { label: "连接与通知", path: "/settings/connections", icon: IconLock },
    {
      label: "使用偏好",
      path: "/settings/account/preferences",
      icon: IconBrush,
    },
  ];
  const team: Entry[] = [
    ...(isAdmin
      ? [{ label: "基本设置", path: "/settings/workspace", icon: IconSettings }]
      : []),
    { label: "成员", path: "/settings/members", icon: IconUsers },
    ...(isAdmin
      ? [{ label: "成员组", path: "/settings/groups", icon: IconUsersGroup }]
      : []),
    { label: "空间", path: "/settings/spaces", icon: IconLayoutGrid },
    ...(isAdmin
      ? [
          {
            label: "飞书集成",
            path: "/settings/authentication",
            icon: IconLock,
          },
        ]
      : []),
  ];
  const groups = [
    { name: "我的", items: account },
    { name: "工作区", items: team },
    {
      name: "系统",
      items: [
        { label: "关于", path: "/settings/about", icon: IconBrandOpenSource },
      ],
    },
  ];
  return (
    <ScrollArea style={{ height: "100%" }}>
      <div style={{ padding: 16 }}>
        <UnstyledButton
          component={Link}
          to="/home"
          onClick={onNavigate}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "8px 10px",
            marginBottom: 18,
          }}
        >
          <IconArrowLeft size={18} />
          返回知识库
        </UnstyledButton>
        {groups.map((group) => (
          <section key={group.name} style={{ marginBottom: 24 }}>
            <Text size="xs" c="dimmed" mb={8} px={10}>
              {group.name}
            </Text>
            {group.items.map(({ label, path, icon: Icon }) => (
              <UnstyledButton
                key={path}
                component={Link}
                to={path}
                onClick={onNavigate}
                aria-current={pathname === path ? "page" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "11px 12px",
                  borderRadius: 8,
                  background:
                    pathname === path
                      ? "var(--mantine-color-default-hover)"
                      : "transparent",
                }}
              >
                <Icon size={19} />
                <Text size="sm">{label}</Text>
              </UnstyledButton>
            ))}
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}
