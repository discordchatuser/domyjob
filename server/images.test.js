import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageStore, imageReferences } from './images.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=', 'base64');
test('extracts image references without treating ordinary links as images', () => {
  assert.deepEqual(imageReferences('![Photo](https://example.com/photo) [local](</tmp/a.png>) [page](https://example.com)'), [{ source: 'https://example.com/photo', name: 'Photo' }, { source: '/tmp/a.png', name: 'local' }]);
});
test('copies local files, downloads remote images, deduplicates and removes only owned copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-images-'));
  try {
    const source = join(root, 'original.png'); await writeFile(source, png);
    let downloads = 0;
    const store = imageStore(join(root, 'data'), { fetchImage: async () => { downloads++; return new Response(png); } });
    const chat = { id: 'thread-a' };
    const local = await store.capture(chat, { source: 'original.png' }, root);
    const remote = await store.capture(chat, { source: 'https://example.com/image.png' });
    assert.equal(downloads, 1); assert.equal(local.id, remote.id); assert.equal(chat.images.length, 1);
    assert.deepEqual(await store.read(chat, local.id), png);
    assert.equal(await store.read({ id: 'thread-b' }, local.id), null);
    await assert.rejects(store.capture(chat, { source: 'data:image/png;base64,' + Buffer.from('<html>oops</html>').toString('base64') }), /Unsupported image/);
    await store.remove(chat.id);
    await assert.rejects(stat(join(root, 'data', 'images', chat.id)), { code: 'ENOENT' });
    assert.ok((await stat(source)).isFile());
  } finally { await rm(root, { recursive: true, force: true }); }
});
