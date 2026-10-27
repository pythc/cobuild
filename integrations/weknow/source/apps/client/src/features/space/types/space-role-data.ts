import { IRoleData, SpaceRole } from "@/lib/types.ts";

export const spaceRoleData: IRoleData[] = [
  {
    label: "Full access",
    value: SpaceRole.ADMIN,
    description:
      "Read, create, edit and delete pages; manage space settings and members.",
  },
  {
    label: "Can edit",
    value: SpaceRole.WRITER,
    description:
      "Read, create, edit and delete pages; cannot manage space settings or members.",
  },
  {
    label: "Can view",
    value: SpaceRole.READER,
    description:
      "Read pages; comments are available when the space allows them.",
  },
];

export function getSpaceRoleLabel(value: string) {
  const role = spaceRoleData.find((item) => item.value === value);
  return role ? role.label : undefined;
}
