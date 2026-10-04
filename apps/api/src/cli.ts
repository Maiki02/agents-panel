import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import qrcode from 'qrcode-terminal';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { CliError, runCli, type CliIo } from './cli/commands.js';

/** Terminal I/O; hidden prompts mute echo so passwords never reach the screen. */
function terminalIo(): CliIo {
  return {
    prompt(question, options) {
      return new Promise((resolve) => {
        let muted = false;
        const output = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            if (!muted) process.stdout.write(chunk);
            callback();
          },
        });
        const rl = createInterface({ input: process.stdin, output, terminal: true });
        rl.question(question, (answer) => {
          rl.close();
          if (options?.hidden) process.stdout.write('\n');
          resolve(answer);
        });
        muted = options?.hidden === true;
      });
    },
    print: (line) => {
      console.log(line);
    },
    qr: (text) => {
      qrcode.generate(text, { small: true });
    },
  };
}

try {
  const config = loadConfig();
  const db = openDatabase(`${config.dataDir}/panel.sqlite`);
  await runCli(process.argv.slice(2), terminalIo(), {
    db,
    secretKey: config.secretKey,
    projectConfig: { projectsDir: config.projectsDir, minFreeDiskGb: config.minFreeDiskGb },
    sessionTimings: {
      idleTtlSeconds: config.sessionIdleTtlSeconds,
      absoluteTtlSeconds: config.sessionAbsoluteTtlSeconds,
    },
  });
} catch (error) {
  console.error(
    error instanceof CliError || error instanceof ConfigError ? error.message : 'Unexpected error',
  );
  process.exitCode = 1;
}
