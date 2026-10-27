import SettingsTitle from "@/components/settings/settings-title";
import WorkspaceNameForm from "@/features/workspace/components/settings/components/workspace-name-form";
import WorkspaceIcon from "@/features/workspace/components/settings/components/workspace-icon";
import WorkspaceDefaultPageEditMode from "@/features/workspace/components/settings/components/workspace-default-page-edit-mode";
import { Divider } from "@mantine/core";
import { DocumentTitle } from "@/components/ui/document-title";
export default function WorkspaceSettings() {
  return (
    <>
      <DocumentTitle title="知识库设置" />
      <SettingsTitle title="常规" />
      <WorkspaceIcon />
      <WorkspaceNameForm />
      <Divider my="md" />
      <WorkspaceDefaultPageEditMode />
    </>
  );
}
