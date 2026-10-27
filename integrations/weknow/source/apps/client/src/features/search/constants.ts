import { createSpotlight } from "@mantine/spotlight";

export const [searchSpotlightStore, searchSpotlight] = createSpotlight();

// The header and keyboard shortcut stay global; the sidebar has its own scope.
export const [spaceSearchSpotlightStore, spaceSearchSpotlight] =
  createSpotlight();

export const [shareSearchSpotlightStore, shareSearchSpotlight] =
  createSpotlight();

export const [publicSpaceSearchSpotlightStore, publicSpaceSearchSpotlight] =
  createSpotlight();
