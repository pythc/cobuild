import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconChevronRight, IconFileText } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useGetSidebarPagesQuery } from '@/features/page/queries/page-query';
import { buildPageUrl } from '@/features/page/page.utils';

/** The core document tree is also the personal archive directory. */
export function PersonalSubpages({ pageId, spaceId, spaceSlug }: { pageId: string; spaceId: string; spaceSlug: string }) {
  const query = useGetSidebarPagesQuery({ pageId, spaceId });
  const pages = query.data?.pages.flatMap(page => page.items) ?? [];
  if (query.isPending) return null;
  if (query.isError) return <Text size="sm" c="dimmed" ta="center">子文档暂时无法加载，<Button variant="subtle" size="compact-sm" onClick={() => void query.refetch()}>重试</Button></Text>;
  if (!pages.length) return null;
  return <Stack maw={900} mx="auto" px="xl" my="xl" gap="xs" aria-label="子文档">
    <Text size="sm" c="dimmed" mb={4}>子文档</Text>
    {pages.map(page => <Paper key={page.id} component={Link} to={buildPageUrl(spaceSlug, page.slugId, page.title)} withBorder radius="md" p="sm" style={{ color:'inherit',textDecoration:'none' }}>
      <Group wrap="nowrap"><IconFileText size={18} stroke={1.6}/><Text size="sm" style={{flex:1}} lineClamp={1}>{page.title || '未命名'}</Text><IconChevronRight size={15}/></Group>
    </Paper>)}
    {query.hasNextPage && <Button variant="subtle" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</Button>}
  </Stack>;
}
