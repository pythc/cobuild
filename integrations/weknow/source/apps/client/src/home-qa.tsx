import React from "react";
import { createRoot } from "react-dom/client";
import {
  MantineProvider,
  Paper,
  Group,
  Text,
  Title,
  Stack,
  Button,
  Container,
} from "@mantine/core";
import "@mantine/core/styles.css";
import {
  IconBookmark,
  IconSchool,
  IconClock,
  IconFileDescription,
  IconHome,
  IconStar,
  IconFolder,
  IconLock,
  IconSearch,
} from "@tabler/icons-react";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "../public/locales/zh-CN/translation.json";
import { WeeklyWritingCard } from "./features/home/components/weekly-writing";
import layout from "./pages/dashboard/home.module.css";
import shortcuts from "./features/home/components/home-shortcuts.module.css";
await i18n
  .use(initReactI18next)
  .init({
    lng: "zh-CN",
    resources: { "zh-CN": { translation: zh } },
    interpolation: { escapeValue: false },
  });
const data = {
  start: "2026-10-11T16:00:00Z",
  end: "2026-10-18T16:00:00Z",
  trackingSince: "2026-10-16T16:00:00Z",
  members: Array.from({ length: 12 }, (_, n) => ({
    userId: String(n),
    name: `示例成员 ${String(n + 1).padStart(2, "0")}`,
    characters: [3420, 2861, 1958, 1280, 954, 530, 301, 190, 105, 0, 0, 0][n],
    edits: [8, 13, 4, 9, 5, 7, 2, 1, 3, 0, 0, 0][n],
    createdPages: [3, 1, 2, 4, 1, 0, 2, 0, 1, 0, 0, 0][n],
  })),
};
const docs = [
  "CoBuild 协作指南",
  "项目文档与开发记录",
  "新人指南 · 从这里开始",
  "知识库使用说明",
  "需求分析与验收清单",
  "会议纪要",
];
const style = document.createElement("style");
style.textContent = `*{box-sizing:border-box}body{margin:0;color:#212529;background:white;font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.qa-note{background:#fff7df;padding:6px;text-align:center;font-size:12px;color:#85681c}.qa-header{height:64px;display:flex;align-items:center;padding:0 30px;gap:15px;background:#f7f8fa;border-bottom:1px solid #e8eaed}.qa-side{position:absolute;left:0;top:94px;bottom:0;width:300px;background:#f7f8fa;padding:25px 18px}.qa-side div{display:flex;align-items:center;gap:12px;padding:12px;border-radius:6px;font-size:14px}.qa-side .selected{background:#e9ecef;font-weight:600}.qa-content{margin-left:300px;padding:16px}.qa-shortcuts{display:grid;grid-template-columns:1fr 1fr;gap:18px}.qa-doc{display:flex;align-items:center;padding:18px 2px;gap:12px;border-bottom:1px solid #e9ecef;font-size:14px}.qa-tabs{display:flex;gap:28px;font-size:14px;border-bottom:1px solid #ddd;padding:15px 0}@media(max-width:767px){.qa-side{display:none}.qa-content{margin-left:0;padding:10px}.qa-header{padding:0 18px}.qa-search{display:none}}`;
document.head.append(style);
function QA() {
  return (
    <MantineProvider>
      <div className="qa-note">本地预览 · 示例数据 · 尚未发布</div>
      <header className="qa-header">
        <svg width="30" height="30" viewBox="0 0 50 50" aria-label="CoBuild">
          <path
            d="M15 5H44L41 12H18L12 36H36L34 44H11L3 35L9 11Z"
            fill="#9398a1"
          />
        </svg>
        <span style={{ color: "#d8dbe1" }}>|</span>
        <img src="/weknow-mark.png" width="25" />
        <b style={{ fontSize: 20 }}>WeKnow</b>
        <Text ml="xl">首页</Text>
        <div
          className="qa-search"
          style={{
            margin: "auto",
            border: "1px solid #ddd",
            background: "white",
            borderRadius: 7,
            padding: "5px 16px",
            color: "#888",
            fontSize: 13,
          }}
        >
          <IconSearch size={14} />
          　搜索全库
        </div>
      </header>
      <nav className="qa-side">
        {[
          [IconLock, "我的知识库"],
          [IconHome, "首页"],
          [IconStar, "收藏"],
          [IconFolder, "空间"],
        ].map(([Icon, label], i) => (
          <div key={i} className={i === 1 ? "selected" : ""}>
            {React.createElement(Icon as any, { size: 18 })}
            {String(label)}
          </div>
        ))}
        <hr
          style={{
            margin: "24px 0",
            border: 0,
            borderTop: "1px solid #e2e5e9",
          }}
        />
        <Text size="xs" c="dimmed" ml="sm">
          收藏的空间
        </Text>
        <div>CoBuild 实验室研发效能</div>
      </nav>
      <main className="qa-content">
        <Container size={1380} py="xl" className={layout.container}>
          <div className={layout.layout}>
            <Stack gap="xl" className={layout.main}>
              <Title order={1} size="h2">
                知识库
              </Title>
              <div className={shortcuts.grid}>
                {[
                  [IconBookmark, "常用文档", "收藏文档，即可固定显示在这里。"],
                  [
                    IconSchool,
                    "新人必读",
                    "为文档添加「新人必读」标签，即可显示在这里。",
                  ],
                ].map(([Icon, title, note], i) => (
                  <Paper key={i} withBorder radius="lg" p="lg">
                    <Group justify="space-between" mb="lg">
                      <Group gap={8}>
                        {React.createElement(Icon as any, { size: 20 })}
                        <b>{String(title)}</b>
                      </Group>
                      <Button size="xs" variant="subtle">
                        查看全部 →
                      </Button>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {String(note)}
                    </Text>
                  </Paper>
                ))}
              </div>
              <div>
                <div className="qa-tabs">
                  <b>
                    <IconClock size={16} />
                    　最近更新
                  </b>
                  <span>☆　收藏</span>
                  <span>我创建的</span>
                </div>
                {docs.map((title, i) => (
                  <div className="qa-doc" key={title}>
                    <IconFileDescription color="#5b8bce" size={17} />
                    <span style={{ flex: 1 }}>{title}</span>
                    <Text size="xs" c="dimmed">
                      今天，上午 {9 + i}:12
                    </Text>
                  </div>
                ))}
              </div>
            </Stack>
            <WeeklyWritingCard data={data} />
          </div>
        </Container>
      </main>
    </MantineProvider>
  );
}
createRoot(document.getElementById("home-qa")!).render(<QA />);
