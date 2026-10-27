import React from "react";
import { Button, Stack, Text, Title } from "@mantine/core";
import { BrandMark } from "./Brand";

/** Failed lazy imports leave an explicit retry instead of a blank page. No automatic reload. */
export class AppErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    const updated = /dynamically imported module|module script|Loading chunk/i.test(this.state.error.message);
    return <main role="alert" style={{maxWidth:480,margin:"16vh auto",padding:24}}>
      <Stack gap="lg" align="flex-start">
        <BrandMark size={40}/>
        <Title order={1} size="h2">{updated ? "页面加载未完成" : "暂时无法打开页面"}</Title>
        <Text c="dimmed">{updated ? "刷新后继续访问当前页面。" : "请刷新重试。"}</Text>
        <Button onClick={()=>window.location.reload()}>刷新页面</Button>
      </Stack>
    </main>;
  }
}
