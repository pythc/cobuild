/** Busboy treats the filename parameter as Latin-1 unless filename* is used. */
export function uploadedFileName(raw: string): string {
  if ([...raw].some((character)=>character.charCodeAt(0)>255)) return raw;
  try { return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(raw,'latin1')); }
  catch { return raw; }
}
