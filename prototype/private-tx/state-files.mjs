import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export async function readStateBytes(path, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 * 1024 * 1024) throw new Error('Invalid state read bound.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('State file exceeds bound or is not ordinary.');
    const chunks = [];
    let length = 0;
    while (length <= maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); length += bytesRead;
    }
    if (length > maximum) throw new Error('State file grew beyond its bound.');
    return Buffer.concat(chunks, length);
  } finally { await file.close(); }
}

export async function readStateJson(path, maximum) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readStateBytes(path, maximum)));
}
