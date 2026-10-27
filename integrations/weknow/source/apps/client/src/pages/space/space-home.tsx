import { Container, Paper, Text, Title } from "@mantine/core";
import SpaceHomeTabs from "@/features/space/components/space-home-tabs.tsx";
import SpacePublicNotice from "@/features/public-space/components/space-public-notice.tsx";
import { useParams } from "react-router-dom";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query.ts";
import { DocumentTitle } from "@/components/ui/document-title.tsx";

export default function SpaceHome() {
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);

  return (
    <>
      <DocumentTitle title={space?.name || "Overview"} />
      <Container size={"900"} pt="xl">
        {space && <SpacePublicNotice space={space} />}
        {space && (
          <Paper
            component="section"
            withBorder
            radius="lg"
            p="lg"
            mb="xl"
            aria-label="空间简介"
          >
            <Title order={1} size="h3" mb="xs">
              {space.name}
            </Title>
            <Text size="xs" fw={600} c="dimmed" mb={6}>
              空间简介
            </Text>
            <Text
              size="sm"
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {space.description || "暂无空间描述"}
            </Text>
          </Paper>
        )}
        {space && <SpaceHomeTabs />}
      </Container>
    </>
  );
}
