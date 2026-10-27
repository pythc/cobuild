const signature = (session) =>
  JSON.stringify([
    session.profile?.subject,
    session.profile?.role,
    session.profile?.recruitmentRole,
    session.profile?.recruitmentCapabilities?.manage,
  ]);
const readDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
export async function uploadMailImage(
  session,
  blob,
  { isCurrent = () => true, read = readDataUrl } = {},
) {
  const identity = signature(session),
    current = () => isCurrent() && signature(session) === identity;
  if (!current()) throw Error("编辑器已关闭");
  if (!blob.size || blob.size > 2 * 1024 * 1024) throw Error("图片需小于 2 MB");
  const url = await read(blob);
  // Reading a local file is asynchronous: do not start a new HTTP request with
  // another account's current credentials after the original editor disappeared.
  if (!current()) throw Error("登录状态已改变，图片未继续上传");
  const meta = await session.request("images", {
    method: "POST",
    data: { requestId: crypto.randomUUID(), data: url.split(",")[1] },
  });
  if (!current()) throw Error("登录状态已改变");
  if (!/^[a-f0-9]{64}$/.test(meta.id)) throw Error("图片上传结果无效");
  return { url, id: meta.id };
}
