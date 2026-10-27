/** Relocate only this application's historical files; ordinary Feishu document links stay intact. */
export function selfhostAssetReferences(value: string): string {
  return value.split('https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x/runtime/api/v1/storage/object/')
    .join('/app/app_17b6pxwde0x/runtime/api/v1/storage/object/');
}
