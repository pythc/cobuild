import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

export async function openNoFollow(file: string): Promise<FileHandle> {
  try {
    return await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EPERM' || code === 'ENOTSUP') {
      throw new Error('Refusing to follow a symlink');
    }
    throw error;
  }
}

export async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await openNoFollow(file);
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function forEachLine(
  file: string,
  onLine: (line: string) => 'stop' | void,
  maxLineBytes = 1_500_000,
): Promise<void> {
  const fh = await openNoFollow(file);
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let discarding = false;
    const consume = (data: Buffer): 'stop' | void => {
      let buf = data;
      if (discarding) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        discarding = false;
        buf = buf.subarray(nl + 1);
        if (buf.length === 0) return;
      }
      pending = Buffer.concat([pending, buf]);
      while (true) {
        const nl = pending.indexOf(0x0a);
        if (nl === -1) break;
        const line = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        if (line.length <= maxLineBytes) {
          const signal = onLine(line.toString('utf8').replace(/\r$/, ''));
          if (signal === 'stop') return 'stop';
        }
      }
      if (pending.length > maxLineBytes) {
        pending = Buffer.alloc(0);
        discarding = true;
      }
    };
    while (true) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const signal = consume(chunk.subarray(0, bytesRead));
      if (signal === 'stop') return;
    }
    if (!discarding && pending.length > 0 && pending.length <= maxLineBytes) {
      onLine(pending.toString('utf8').replace(/\r$/, ''));
    }
  } finally {
    await fh.close();
  }
}
