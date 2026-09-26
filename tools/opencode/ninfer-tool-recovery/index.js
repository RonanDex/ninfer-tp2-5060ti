import {mkdir, writeFile, rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createRecovery} from './recovery.js';

export default {
  id: 'local.ninfer-tool-recovery',
  async setup(ctx) {
    const dir = join(homedir(), '.local/state/opencode/ninfer-tool-recovery');
    const audit = async value => {
      await mkdir(dir, {recursive: true, mode: 0o700});
      const path = join(dir, `${value.sessionID}.json`);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
      await rename(tmp, path);
    };
    const recovery = createRecovery(ctx, {audit});
    await ctx.session.hook('prompt', event => recovery.prompt(event));
    const controller = new AbortController();
    const reader = (async () => {
      for await (const event of ctx.event.subscribe({signal: controller.signal})) {
        await recovery.event(event);
      }
    })().catch(() => {});
    return async () => { controller.abort(); await recovery.close(); await reader; };
  },
};
