import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
export const envPath = fileURLToPath(new URL('../.env', import.meta.url));
try { loadEnvFile(envPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
