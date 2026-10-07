import { createApp } from './app.js';
import { createCodex } from './codex.js';
let codexPromise;
const server = await createApp({ getCodex: async () => {
  if (!codexPromise) codexPromise = createCodex().catch(error => { codexPromise = null; throw error; });
  return codexPromise;
} });
server.listen(3001, '127.0.0.1', () => console.log('Backend: http://127.0.0.1:3001'));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const timeout = setTimeout(() => process.exit(1), 10000);
  try { if (codexPromise) await (await codexPromise).close(); }
  catch (error) { console.error(error.message); }
  finally { clearTimeout(timeout); process.exit(0); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
