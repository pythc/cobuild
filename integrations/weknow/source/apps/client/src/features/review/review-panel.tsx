import {
  Button,
  Group,
  Stack,
  Text,
  Textarea,
  Paper,
  Badge,
  SegmentedControl,
  Alert,
} from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { diffWordsWithSpace } from "diff";
import api from "@/lib/api-client";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import { captureReview, reviewDraftAtom } from "./review-state";
import classes from "./review.module.css";

export function ReviewDiff({
  original,
  replacement,
}: {
  original: string;
  replacement: string;
}) {
  return (
    <div className={classes.diff}>
      {diffWordsWithSpace(original, replacement).map((part, i) =>
        part.added ? (
          <ins key={i}>{part.value}</ins>
        ) : part.removed ? (
          <del key={i}>{part.value}</del>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </div>
  );
}

export function ReviewPanel({
  pageId,
  canEdit,
  canComment,
}: {
  pageId: string;
  canEdit: boolean;
  canComment: boolean;
}) {
  const client = useQueryClient(),
    editor = useAtomValue(pageEditorAtom);
  const [{ value: draft }, writeDraft] = useAtom(reviewDraftAtom),
    [replacement, setReplacement] = useState(""),
    [filter, setFilter] = useState("pending"),
    [error, setError] = useState("");
  const setDraft = (value: import("./review-state").ReviewDraft | null) =>
    writeDraft({ value });
  const current = draft?.pageId === pageId ? draft : null;
  useEffect(() => {
    if (current) setReplacement(current.original);
  }, [current?.id]);
  const query = useQuery({
    queryKey: ["document-reviews", pageId],
    enabled: !!pageId,
    queryFn: async () =>
      (await api.post("/review/list", { pageId })).data as any[],
    refetchInterval: 15000,
  });
  const mutation = useMutation({
    mutationFn: async (data: any) =>
      api.post(data.decision ? "/review/decide" : "/review/create", data),
    onSuccess: (_, variables) => {
      setError("");
      if (!variables.decision) {
        setDraft(null);
        setReplacement("");
      }
      void client.invalidateQueries({ queryKey: ["document-reviews", pageId] });
    },
    onError: (e: any) => {
      setError(
        e.response?.data?.message || "未能确认操作结果，请重试同一条建议",
      );
      void client.invalidateQueries({ queryKey: ["document-reviews", pageId] });
    },
  });
  const rows = (query.data || []).filter(
    (r) => filter === "all" || r.status === "pending",
  );
  function capture() {
    const v = editor && captureReview(editor, pageId);
    if (!v) {
      setError("请在正文中选择同一段落内的文字");
      return;
    }
    setError("");
    setDraft(v);
    setReplacement(v.original);
  }
  return (
    <Stack gap="md" className={classes.panel}>
      <Text size="sm" c="dimmed">
        修改建议保留原文，由有编辑权限的成员决定是否采纳。
      </Text>
      {canComment && !current && (
        <Button
          variant="light"
          onMouseDown={(e) => e.preventDefault()}
          onClick={capture}
        >
          为选中文字提出建议
        </Button>
      )}
      {current && (
        <Paper withBorder p="sm" radius="md">
          <Text size="xs" c="dimmed">
            原文
          </Text>
          <Text size="sm" className={classes.original}>
            {current.original}
          </Text>
          <Textarea
            label="建议改为"
            aria-label="建议改为"
            placeholder="留空表示建议删除这段文字"
            autosize
            minRows={3}
            maxRows={9}
            maxLength={8000}
            value={replacement}
            onChange={(e) => setReplacement(e.currentTarget.value)}
          />
          <Group mt="sm" justify="flex-end">
            <Button variant="subtle" size="xs" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button
              size="xs"
              loading={mutation.isPending}
              disabled={replacement === current.original}
              onClick={() => mutation.mutate({ ...current, replacement })}
            >
              提交建议
            </Button>
          </Group>
        </Paper>
      )}
      {error && (
        <Alert color="orange" role="alert">
          {error}
        </Alert>
      )}
      <SegmentedControl
        fullWidth
        value={filter}
        onChange={(v) => setFilter(String(v))}
        data={[
          { value: "pending", label: "待处理" },
          { value: "all", label: "全部记录" },
        ]}
      />
      {query.isError && (
        <Alert color="red">
          无法读取修订记录
          <Button variant="subtle" size="xs" onClick={() => query.refetch()}>
            重试
          </Button>
        </Alert>
      )}
      {!query.isLoading && !rows.length && (
        <Text size="sm" c="dimmed">
          {filter === "pending" ? "没有待处理的建议" : "还没有修订建议"}
        </Text>
      )}
      {rows.map((row) => (
        <Paper key={row.id} withBorder radius="md" p="sm">
          <Group justify="space-between" gap="xs">
            <Text size="sm" fw={500}>
              {row.creatorName || "已离职成员"}
            </Text>
            <Badge
              variant="light"
              color={
                row.status === "accepted"
                  ? "teal"
                  : row.status === "pending"
                    ? "blue"
                    : "gray"
              }
            >
              {row.status === "accepted"
                ? "已采纳"
                : row.status === "pending"
                  ? "待处理"
                  : "已拒绝"}
            </Badge>
          </Group>
          <ReviewDiff original={row.original} replacement={row.replacement} />
          {row.status === "pending" && canEdit ? (
            <Group justify="flex-end" gap="xs">
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ id: row.id, decision: "rejected" })
                }
              >
                拒绝
              </Button>
              <Button
                size="xs"
                variant="light"
                loading={
                  mutation.isPending && mutation.variables?.id === row.id
                }
                onClick={() =>
                  mutation.mutate({ id: row.id, decision: "accepted" })
                }
              >
                采纳修改
              </Button>
            </Group>
          ) : (
            row.resolvedAt && (
              <Text size="xs" c="dimmed">
                {row.resolvedByName || "成员"} ·{" "}
                {new Date(row.resolvedAt).toLocaleString()}
              </Text>
            )
          )}
        </Paper>
      ))}
      {(query.data?.length || 0) >= 200 && (
        <Text size="xs" c="dimmed">
          显示最近 200 条记录
        </Text>
      )}
    </Stack>
  );
}
