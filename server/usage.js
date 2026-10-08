import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export function usageStore(dataDir = '.data') {
  const directory = resolve(dataDir, 'usage');
  let pending = Promise.resolve();
  async function records() {
    await pending;
    let files; try { files = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return (await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => { try { return JSON.parse(await readFile(resolve(directory, f), 'utf8')); } catch { return null; } }))).filter(Boolean);
  }
  function record(event) {
    pending = pending.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true });
      const id = event.id || randomUUID();
      const file = resolve(directory, createHash('sha256').update(id).digest('hex') + '.json');
      const value = { ...event, id, at: event.at || new Date().toISOString() };
      if (event.provider === 'codex') {
        let old; try { old = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (old?.tokens?.totalTokens > event.tokens.totalTokens) return;
      }
      const temp = file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify(value)); await rename(temp, file);
    });
    return pending;
  }
  return { record, records };
}
export async function openRouterAccount(fetchImpl = fetch, key = process.env.OPENROUTER_API_KEY) {
  if (!key?.trim()) return { available: false, reason: 'Add OPENROUTER_API_KEY to enable account reporting.' };
  try {
    const response = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error();
    const { data } = await response.json();
    const result = { available: true };
    for (const field of ['usage', 'usage_daily', 'usage_weekly', 'usage_monthly', 'limit', 'limit_remaining']) if (typeof data?.[field] === 'number' && Number.isFinite(data[field])) result[field] = data[field];
    return result;
  } catch { return { available: false, reason: 'OpenRouter account reporting is unavailable.' }; }
}
