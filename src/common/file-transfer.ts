import { open, rm } from 'node:fs/promises';

/** Stream to an exclusive owner-only destination, enforcing actual bytes. */
export async function saveStream(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<number> {
  const file = await open(path, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > maxBytes)
        throw new Error(`File exceeds the configured ${maxBytes} byte limit`);
      await file.writeFile(chunk);
    }
    return size;
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  } finally {
    await file.close();
  }
}

/** Fetch's stream as bounded chunks; cancel when the consumer stops early. */
export async function* responseChunks(
  response: Response,
): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw new Error('Download has no body');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      yield result.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
