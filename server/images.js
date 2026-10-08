import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const limit = 20 * 1024 * 1024;
export function imageReferences(text = '') {
  return [...text.matchAll(/!?\[([^\]]*)\]\(<?([^\s>]+)>?(?:\s+"[^"]*")?\)/g)]
    .filter(match => match[0].startsWith('!') || /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(match[2]))
    .map(match => ({ source: match[2], name: match[1] || 'Image' }));
}
export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Unsupported image format (use PNG, JPEG, GIF or WebP)');
}
export function imageStore(dataDir, { fetchImage = fetch } = {}) {
  const directory = id => resolve(dataDir, 'images', id);
  return {
    async capture(chat, reference, cwd) {
      let bytes;
      const source = reference.source;
      if (/^https?:\/\//i.test(source)) {
        const response = await fetchImage(source, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Image download failed: HTTP ' + response.status);
        if (Number(response.headers.get('content-length')) > limit) throw new Error('Image exceeds 20 MB');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Image exceeds 20 MB'); chunks.push(chunk); }
        bytes = Buffer.concat(chunks);
      } else if (reference.base64 || source.startsWith('data:image/')) {
        const encoded = reference.base64 || source.slice(source.indexOf(',') + 1);
        if (encoded.length > limit * 4 / 3 + 4) throw new Error('Image exceeds 20 MB');
        bytes = Buffer.from(encoded, 'base64');
      } else {
        const path = source.startsWith('file:') ? fileURLToPath(source) : resolve(cwd || process.cwd(), decodeURIComponent(source.replace(/^sandbox:/, '')));
        if ((await stat(path)).size > limit) throw new Error('Image exceeds 20 MB');
        bytes = await readFile(path);
      }
      if (bytes.length > limit) throw new Error('Image exceeds 20 MB');
      const type = imageType(bytes);
      const id = createHash('sha256').update(bytes).digest('hex') + '.' + type;
      await mkdir(directory(chat.id), { recursive: true });
      await writeFile(resolve(directory(chat.id), id), bytes);
      const image = { id, name: reference.name || basename(source) || 'Image', url: `/api/chats/${chat.id}/images/${id}`, type, ...(reference.prompt ? { prompt: reference.prompt } : {}) };
      chat.images ||= [];
      const existing = chat.images.find(item => item.id === id);
      if (existing) { if (image.prompt) { existing.prompt = image.prompt; existing.name = image.name; } return existing; }
      chat.images.push(image);
      return image;
    },
    async read(chat, id) {
      if (!chat.images?.some(image => image.id === id)) return null;
      return readFile(resolve(directory(chat.id), id));
    },
    remove: id => rm(directory(id), { recursive: true, force: true }),
  };
}
