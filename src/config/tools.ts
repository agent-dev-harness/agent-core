export const RUN_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'run_terminal_docker',
    description: 'Executes an arbitrary terminal command or script securely inside an isolated, containerized environment. Use this for all file creations, terminal commands, or testing operations. Each call runs a fresh bash process: working directory and environment variables do NOT persist between calls, so chain multi-step work with && inside one command. Use workingDir for directory context (relative paths resolve against the workspace root; absolute paths must stay inside it). The call waits up to initialWaitSeconds (default 60) for the command to finish. A command still running then is NOT killed: it keeps running in the background and the result has status "running" and a shellId, with the output so far. Use read_terminal_docker with that shellId to wait for more output and the exit code, and stop_terminal_docker to stop it. For a server, watcher or other long-lived process, use mode "async". Processes a command leaves running (e.g. started with &) are killed when the session ends. Very large output is truncated: stdout and stderr together keep ~40k chars, from the start and end of each. Never delete the workspace\'s snapshots/ directory: it holds the session\'s checkpoints.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash script to run. In the default sync mode the command gets an empty stdin, so a program that prompts for input sees end-of-file instead of waiting; pass input with flags, pipes or heredocs. In async mode stdin stays open for write_terminal_docker.' },
        workingDir: { type: 'string', description: 'The directory to run the command in. Relative paths resolve against the workspace root (default); absolute paths must remain inside the workspace. Does not persist between calls.' },
        initialWaitSeconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Seconds to wait for the command to finish before returning with status "running" (the command keeps running). Default 60. Raise it (e.g. 120-300) for builds, installs or test suites you want to wait for.' },
        mode: { type: 'string', enum: ['sync', 'async'], description: '"sync" (default): wait up to initialWaitSeconds. "async": return at once with a shellId and leave stdin open; use for servers, watchers and interactive programs.' }
      },
      required: ['command']
    }
  }
} as const;

export const READ_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'read_terminal_docker',
    description: 'Gets the output a background command (started by run_terminal_docker) produced since the last call, and its exit code once it has finished. Waits up to waitSeconds for the command to finish first. After the exit has been reported, the shellId is forgotten; so are the oldest finished commands once more than 20 are unread.',
    parameters: {
      type: 'object',
      properties: {
        shellId: { type: 'string', description: 'The shellId returned by run_terminal_docker.' },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Max seconds to wait for the command to finish before returning the output so far. Default 10.' }
      },
      required: ['shellId']
    }
  }
} as const;

export const WRITE_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'write_terminal_docker',
    description: 'Sends input to the stdin of a command started with run_terminal_docker in mode "async", then returns its new output like read_terminal_docker.',
    parameters: {
      type: 'object',
      properties: {
        shellId: { type: 'string', description: 'The shellId returned by run_terminal_docker.' },
        input: { type: 'string', description: 'Text to send, exactly as given. Include "\\n" to press Enter.' },
        endInput: { type: 'boolean', description: 'Close stdin after sending input, so the program sees end-of-file.' },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 600, description: 'Max seconds to wait for the command to finish before returning the output so far. Default 2.' }
      },
      required: ['shellId']
    }
  }
} as const;

export const STOP_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'stop_terminal_docker',
    description: 'Stops a background command started by run_terminal_docker, killing it and every process it started, and returns its remaining output.',
    parameters: {
      type: 'object',
      properties: {
        shellId: { type: 'string', description: 'The shellId returned by run_terminal_docker.' }
      },
      required: ['shellId']
    }
  }
} as const;

export const LIST_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'list_terminal_docker',
    description: 'Lists the background commands started by run_terminal_docker that are still running or whose exit has not been read yet.',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
} as const;

export const TERMINAL_DOCKER_TOOLS = [
  RUN_TERMINAL_DOCKER_TOOL,
  READ_TERMINAL_DOCKER_TOOL,
  WRITE_TERMINAL_DOCKER_TOOL,
  STOP_TERMINAL_DOCKER_TOOL,
  LIST_TERMINAL_DOCKER_TOOL,
] as const;
