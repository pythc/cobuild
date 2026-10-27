import { BrandMark } from "@/platform/Brand";
import React from "react";
import { Group, Text } from "@mantine/core";
import classes from "./auth.module.css";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" gap={8} className={classes.logo}>
        <BrandMark size={30} />
        <Text size="28px" fw={700} style={{ userSelect: "none" }}>
          WeKnow
        </Text>
      </Group>
      <main>{children}</main>
    </>
  );
}
