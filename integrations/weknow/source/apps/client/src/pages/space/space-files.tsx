import { useParams } from "react-router-dom";
import { useGetSpaceBySlugQuery } from "@/features/space/queries/space-query";
import { useSpaceAbility } from "@/features/space/permissions/use-space-ability";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type";
import { OfficeDirectory } from "@/features/office/office-directory";
export default function SpaceFiles() {
  const { spaceSlug } = useParams();
  const { data: space } = useGetSpaceBySlugQuery(spaceSlug);
  const ability = useSpaceAbility(space?.membership?.permissions);
  return space ? (
    <OfficeDirectory
      target={{ spaceId: space.id }}
      title={space.name}
      canEdit={ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page)}
    />
  ) : null;
}
