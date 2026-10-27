import WeeklyWriting from "@/features/home/components/weekly-writing";
import classes from "./home.module.css";
import { Container, Stack, Title } from "@mantine/core";
import HomeTabs from "@/features/home/components/home-tabs";
import HomeAiPrompt from "@/features/home/components/home-ai-prompt";
import { useTranslation } from "react-i18next";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import HomeShortcuts from "@/features/home/components/home-shortcuts";

export default function Home() {
  const { t } = useTranslation();

  return (
    <>
      <DocumentTitle title={t("Home")} />
      <Container size={1380} py="xl" className={classes.container}>
        <div className={classes.layout}>
          <Stack gap="xl" className={classes.main}>
            <Title order={1} size="h2">
              {t("Knowledge home")}
            </Title>
            <HomeAiPrompt />
            <HomeShortcuts />
            <HomeTabs />
          </Stack>
          <WeeklyWriting />
        </div>
      </Container>
    </>
  );
}
