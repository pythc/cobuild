import React, { useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import {
  Badge,
  ComboboxItem,
  Group,
  Loader,
  MultiSelect,
  MultiSelectProps,
  Text,
} from "@mantine/core";
import { useSearchSuggestionsQuery } from "@/features/search/queries/search-query.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { IconGroupCircle } from "@/components/icons/icon-people-circle.tsx";
import { useTranslation } from "react-i18next";

interface MultiMemberSelectProps {
  value?: string[];
  onChange: (value: string[]) => void;
}
interface MemberOption extends ComboboxItem {
  type: "user" | "group";
  avatarUrl?: string;
  syncedLabel?: string;
}

const renderMultiSelectOption: MultiSelectProps["renderOption"] = ({
  option,
}) => {
  const member = option as MemberOption;
  return (
    <Group gap="sm" wrap="nowrap">
      {member.type === "user" ? (
        <CustomAvatar
          avatarUrl={member.avatarUrl}
          size={20}
          name={member.label}
        />
      ) : (
        <IconGroupCircle />
      )}
      <Text size="sm" lineClamp={1}>
        {member.label}
      </Text>
      {member.syncedLabel && (
        <Badge size="xs" variant="light" color="teal">
          {member.syncedLabel}
        </Badge>
      )}
    </Group>
  );
};

export function MultiMemberSelect({ value, onChange }: MultiMemberSelectProps) {
  const { t } = useTranslation();
  const [searchValue, setSearchValue] = useState("");
  const [debouncedQuery] = useDebouncedValue(searchValue, 250);
  const {
    data: suggestion,
    isFetching,
    isError,
  } = useSearchSuggestionsQuery({
    query: debouncedQuery,
    includeUsers: true,
    includeGroups: true,
    preload: true,
  });
  // Keep labels for selected members when another search replaces the results.
  const [selectedOptions, setSelectedOptions] = useState<MemberOption[]>([]);
  const options: MemberOption[] = [
    ...(suggestion?.groups ?? []).map((group) => ({
      value: `group-${group.id}`,
      label: group.isDefault ? t("All members (automatic)") : group.name,
      type: "group" as const,
      syncedLabel: group.isExternal ? t("Feishu sync") : undefined,
    })),
    ...(suggestion?.users ?? []).map((user) => ({
      value: `user-${user.id}`,
      label: user.name,
      avatarUrl: user.avatarUrl,
      type: "user" as const,
    })),
  ];
  const mergedOptions = [
    ...options,
    ...selectedOptions.filter(
      (selected) =>
        value?.includes(selected.value) &&
        !options.some((option) => option.value === selected.value),
    ),
  ];
  const data = [
    {
      group: t("Select a group"),
      items: mergedOptions.filter((option) => option.type === "group"),
    },
    {
      group: t("Select a user"),
      items: mergedOptions.filter((option) => option.type === "user"),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <MultiSelect
      data={data}
      value={value}
      renderOption={renderMultiSelectOption}
      hidePickedOptions
      maxDropdownHeight={300}
      label={t("Add members")}
      placeholder={t("Search for users and groups")}
      searchable
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      filter={({ options }) => options}
      nothingFoundMessage={isFetching ? t("Loading") : t("No results found")}
      rightSection={isFetching ? <Loader size={16} /> : undefined}
      error={isError ? t("Could not load members. Try again.") : undefined}
      clearable
      variant="filled"
      onChange={(nextValue) => {
        setSelectedOptions(
          mergedOptions.filter((option) => nextValue.includes(option.value)),
        );
        onChange(nextValue);
      }}
      maxValues={50}
    />
  );
}
