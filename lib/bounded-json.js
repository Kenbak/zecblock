// Count decoded stream bytes, not Content-Length: fetch may transparently
// decompress a response whose compressed length is much smaller than its body.
async function readBoundedJson(response, maxBytes = 2 * 1024 * 1024, timeoutMs = 8000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid JSON byte limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing JSON response body');
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('JSON response deadline exceeded')), timeoutMs);
    });
    const read = async () => {
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('JSON response exceeds byte limit');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    return await Promise.race([read(), deadline]);
  } catch (error) {
    // Cancellation must not wait for an uncooperative upstream to finish.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

module.exports = { readBoundedJson };
