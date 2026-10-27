// Display-only branding. Application IDs, destinations and permissions stay intact.
export const COBUILD_BRAND = Object.freeze({
  name: 'CoBuild',
  scope: 'suite',
  wordmarkUrl: '/assets/cobuild/cobuild-wordmark.svg',
  inverseWordmarkUrl: '/assets/cobuild/cobuild-wordmark-white.svg',
});

export const APP_BRANDS = Object.freeze(Object.fromEntries([
  ['monitoring', 'Pulse', '运行监控', 'pulse', 'svg'],
  ['projects', 'Kick', '项目立项', 'kick'],
  ['knowledge', 'WeKnow', '知识库', 'weknow'],
  ['recruitment-test', 'HiFlow', '招新管理', 'hiflow'],
  ['assessment', 'Evalab', '考核系统', 'evalab'],
  ['relay', 'Relay', '客服', 'relay', 'svg'],
  ['requirements', 'Makit', '需求平台', 'requirements-logo', 'svg'],
].map(([id, title, originalTitle, file, extension = 'png']) => [id, Object.freeze({
  title, originalTitle, iconUrl: `/assets/cobuild/${file}.${extension}`,
})])));

export function getAppPresentation(app) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    throw new TypeError('Expected an application object');
  }
  const brand = Object.hasOwn(APP_BRANDS, app.id) ? APP_BRANDS[app.id] : null;
  return brand
    ? {...app, ...brand}
    : {...app, originalTitle: app.originalTitle ?? app.title, iconUrl: app.iconUrl ?? null};
}

export function applyAppBranding(apps) {
  if (!Array.isArray(apps)) throw new TypeError('Expected an application array');
  return apps.map(getAppPresentation);
}

// Consumers should search this text instead of only the new display title.
export function getAppSearchText(app) {
  const value = getAppPresentation(app);
  return [value.id, value.title, value.originalTitle, value.description, value.edition]
    .filter(part => typeof part === 'string')
    .join(' ')
    .normalize('NFC')
    .toLocaleLowerCase('en');
}
