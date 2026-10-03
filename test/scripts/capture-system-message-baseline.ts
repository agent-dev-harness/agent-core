// Captures the SDK's current system message so test/systemMessageBaseline.ts can be diffed
// against it after an SDK upgrade. Usage: npx tsx test/scripts/capture-system-message-baseline.ts
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { CapiProxy } from '../harness/CapiProxy';
import { CopilotClient } from '../../src/copilotSdk/boundary';
import { stripSdkGeneratedDynamicSections } from '../systemMessageBaseline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const proxy = new CapiProxy();
  const proxyUrl = await proxy.start();
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-capture-'));

  const snapshotPath = path.resolve(
    __dirname,
    '../snapshots/session_wrapper/create_resume.yaml'
  );
  await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

  const client = new CopilotClient({
    workingDirectory: tmpWorkDir,
    logLevel: 'none',
    useLoggedInUser: false,
    env: {
      ...process.env,
      ...proxy.getProxyEnv(),
      COPILOT_API_URL: proxyUrl,
    },
  });

  await client.start();
  try {
    const session = await client.createSession({
      model: 'claude-sonnet-4.5',
      provider: { type: 'openai', baseUrl: proxyUrl, apiKey: 'test-api-key' },
      availableTools: [],
      autoApproveAll: false,
      onPermissionRequest: async () => ({ kind: 'reject', feedback: 'no tools' }),
    } as any);

    await session.sendAndWait('Hello', 15000);

    const completions = proxy.requestHistory.filter((r: any) => Array.isArray(r.messages));
    const sys = completions[0]?.messages.find((m: any) => m.role === 'system')?.content ?? '';
    const outPath = path.join(os.tmpdir(), 'copilot-sdk-system-message-capture.txt');
    fs.writeFileSync(outPath, sys);
    const strippedOutPath = path.join(os.tmpdir(), 'copilot-sdk-system-message-capture.stripped.txt');
    fs.writeFileSync(strippedOutPath, stripSdkGeneratedDynamicSections(sys));
    console.log('Captured', sys.length, 'chars to', outPath);
    console.log('Stripped capture written to', strippedOutPath);
  } finally {
    await client.stop();
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
