export interface CliInteractivity {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

/**
 * MCP hosts start package commands with piped stdio, while a human terminal
 * has TTYs on both streams. Humans get the usage summary, while piped
 * launches (registry probes, generic MCP launchers) start the MCP server.
 */
export function shouldDefaultToMcp(options: CliInteractivity = {}): boolean {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY;
  return stdinIsTTY !== true || stdoutIsTTY !== true;
}
