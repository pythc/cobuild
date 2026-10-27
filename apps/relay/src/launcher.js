export const LAUNCHER_SIZE = 52;
const EDGE = 16;
const clamp = (n, low, high) => Math.min(Math.max(n, low), Math.max(low, high));

export function launcherPosition(position, viewport) {
  const {width, height} = viewport;
  const valid = Number.isFinite(position?.x) && Number.isFinite(position?.y);
  return {
    x: clamp(valid ? position.x : width - LAUNCHER_SIZE - 26, EDGE, width - LAUNCHER_SIZE - EDGE),
    y: clamp(valid ? position.y : height - LAUNCHER_SIZE - 22, EDGE, height - LAUNCHER_SIZE - EDGE),
  };
}

export function panelPosition(position, viewport) {
  if (viewport.width <= 760) return {left: 0, top: 0, width: '100%', height: '100dvh'};
  const width = Math.min(395, viewport.width - EDGE * 2);
  const aboveSpace = Math.max(0, position.y - EDGE - 12);
  const belowSpace = Math.max(0, viewport.height - position.y - LAUNCHER_SIZE - EDGE - 12);
  const height = Math.min(610, Math.max(aboveSpace, belowSpace));
  const left = position.x > viewport.width / 2 ? position.x + LAUNCHER_SIZE - width : position.x;
  const above = position.y - height - 12;
  const below = position.y + LAUNCHER_SIZE + 12;
  const top = aboveSpace >= belowSpace ? above : below;
  return {left: clamp(left, EDGE, viewport.width - width - EDGE), top: clamp(top, EDGE, viewport.height - height - EDGE), width, height};
}
