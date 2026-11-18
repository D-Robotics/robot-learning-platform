import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export default class StudioRunProvider {
  id() {
    return 'studio-native-run-routing';
  }

  async callApi(prompt, { vars }) {
    const source = process.env.RDK_STUDIO_SOURCE_DIR;
    const modelConfig = process.env.RDK_STUDIO_EVAL_MODEL_CONFIG;
    const scripted = process.env.RDK_STUDIO_EVAL_SCRIPTED_MODEL;
    if (!source || Boolean(modelConfig) === Boolean(scripted)) {
      return {
        error:
          'Set RDK_STUDIO_SOURCE_DIR and exactly one of RDK_STUDIO_EVAL_MODEL_CONFIG or RDK_STUDIO_EVAL_SCRIPTED_MODEL.',
      };
    }
    try {
      const studio = resolve(source);
      const loader = createRequire(join(studio, 'package.json')).resolve('tsx/esm');
      const { stdout } = await exec(
        process.execPath,
        [
          '--import',
          pathToFileURL(loader).href,
          fileURLToPath(new URL('./studio-session.mjs', import.meta.url)),
        ],
        {
          env: {
            ...process.env,
            RDK_STUDIO_SOURCE_DIR: studio,
            ...(modelConfig ? { RDK_STUDIO_EVAL_MODEL_CONFIG: resolve(modelConfig) } : {}),
            RDK_STUDIO_EVAL_CASE: JSON.stringify({
              first: prompt,
              followup: vars.followup,
              runId: vars.runId,
            }),
          },
          timeout: 250_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const receipt = stdout.split('\n').findLast((line) => line.startsWith('STUDIO_EVAL '));
      if (!receipt) return { error: 'Studio did not emit a routing receipt.' };
      return { output: JSON.parse(receipt.slice('STUDIO_EVAL '.length)) };
    } catch (error) {
      // Child logs can contain model/provider configuration. Keep them out of eval exports.
      return { error: `Studio session runner failed (${error.code ?? error.name}).` };
    }
  }
}
