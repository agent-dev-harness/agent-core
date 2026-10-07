import { describe, it, expect, vi } from 'vitest';
import { defineTool, makeTerminalDockerHandlers, TERMINAL_DOCKER_TOOLS } from '../src/index';

// Registration needs an initialized workspace, which needs Docker; this test only checks the snippet.
vi.mock('../src/workspace/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/workspace/workspace')>()),
  isWorkspaceInitialized: () => true,
}));

// The README's registration snippet, verbatim: `npm run lint` typechecks it under strict mode.
describe('README tool registration', () => {
  it('compiles and registers all five terminal tools', () => {
    const sessionAbort = new AbortController();
    const terminal = makeTerminalDockerHandlers(sessionAbort.signal);
    const tools = TERMINAL_DOCKER_TOOLS.map(({ function: f }) =>
      defineTool(f.name, f.description, f.parameters, (args, invocation) => terminal[f.name](args, invocation)),
    );
    expect(tools.map((t) => t.name)).toEqual([
      'run_terminal_docker',
      'read_terminal_docker',
      'write_terminal_docker',
      'stop_terminal_docker',
      'list_terminal_docker',
    ]);
  });
});
