import {
  validateSavedViewConfig,
  type SavedViewConfig,
} from '@shared/workspace-efficiency';

const KEYS: Record<string, string> = {
  search: 'q',
  iterationId: 'iteration',
  handlerId: 'handler',
  productOwnerId: 'product',
  developerId: 'developer',
  testerId: 'tester',
  foOwnerId: 'fo',
  groupBy: 'group',
  mineOnly: 'mine',
};
export function savedViewSearch(config: SavedViewConfig): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(config.query)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(KEYS[key] || key, value === true ? '1' : String(value));
  }
  if (config.viewMode)
    params.set('view', config.viewMode === 'cards' ? 'cards' : 'table');
  return params;
}

export function legacySavedViewConfig(raw: string): SavedViewConfig | null {
  const params = new URLSearchParams(raw);
  const reverse = Object.fromEntries(
    Object.entries(KEYS).map(([key, value]) => [value, key]),
  );
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of params) {
    if (['page', 'create', 'returnTo', 'view'].includes(key) || !value)
      continue;
    const name = reverse[key] || key;
    query[name] =
      name === 'mineOnly'
        ? value === '1'
        : name === 'pageSize'
          ? Number(value)
          : value;
  }
  const config = {
    query,
    viewMode: params.get('view') === 'cards' ? 'cards' : 'list',
  };
  return validateSavedViewConfig(config) ? config : null;
}
