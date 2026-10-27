export function canInteract(config, openId) {
  if (config.authorization?.ownerOnly !== true) return true;
  if (!openId) return false;
  return (config.authorization.ownerOpenIds || []).includes(openId);
}
