/**
 * Load env from project root: .env first, then .env.example for any unset vars.
 * Real secrets should live in .env (gitignored); .env.example is the tracked template.
 * If root .env is missing but cwd/.env exists, load cwd last so local overrides win.
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';

function hasEnvFiles(dir) {
  return existsSync(join(dir, '.env')) || existsSync(join(dir, '.env.example'));
}

export async function loadProjectEnv(root) {
  try {
    const { config } = await import('dotenv');
    const envPath = join(root, '.env');
    const examplePath = join(root, '.env.example');
    const cwdEnv = join(process.cwd(), '.env');

    config({ path: envPath });
    if (existsSync(examplePath)) {
      config({ path: examplePath, override: false });
    }
    if (!existsSync(envPath) && existsSync(cwdEnv) && cwdEnv !== envPath) {
      config({ path: cwdEnv, override: true });
      if (existsSync(examplePath)) {
        config({ path: examplePath, override: false });
      }
    }
    // Scripts under a subfolder (e.g. career-ops/) with no env files: use parent repo root.
    if (!hasEnvFiles(root)) {
      const parent = resolve(root, '..');
      if (parent !== resolve(root) && hasEnvFiles(parent)) {
        config({ path: join(parent, '.env') });
        if (existsSync(join(parent, '.env.example'))) {
          config({ path: join(parent, '.env.example'), override: false });
        }
      }
    }
  } catch {
    /* dotenv optional */
  }
}
