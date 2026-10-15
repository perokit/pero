import type { InboundCommand } from '../channel-adapter.js';

// Shared by the integrations and the daemon. Keep this free of Nest imports.

/** A command Pero answers itself, as integrations list it. */
export interface CommandInfo {
  /** Lowercase letters, digits, and `_`, without the `/`. */
  name: string;
  /** One line for the integration's command menu and `/help`. */
  description: string;
}

/** Every command, in the order menus show them. */
export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'status',
    description: "This topic's settings, its conversation, and Pero",
  },
  {
    name: 'new',
    description: 'Start this topic over, without the conversation so far',
  },
  { name: 'stop', description: "Stop Pero's answer in this topic" },
  { name: 'topic', description: 'Create a topic in this Telegram group' },
  {
    name: 'files',
    description: 'File limits, audio processing time and result delivery',
  },
  { name: 'model', description: "Show or change this topic's model" },
  {
    name: 'effort',
    description: "Show or change this topic's reasoning effort",
  },
  { name: 'workflows', description: 'Workflows, when they run, and how' },
  { name: 'run', description: 'Run a Workflow now' },
  { name: 'runs', description: 'Recent Workflow runs, and how they went' },
  { name: 'cancel', description: 'Cancel a waiting or running Workflow run' },
  { name: 'retry', description: 'Run a failed Workflow run again' },
  { name: 'help', description: "What Pero's commands do" },
];

const NAMES: ReadonlySet<string> = new Set(COMMANDS.map(({ name }) => name));

/** Whether Pero answers `/name` itself rather than as a message. */
export function isCommand(name: string): boolean {
  return NAMES.has(name);
}

/**
 * The command a button runs: its ID is the command's text, such as
 * `/new yes`. Null for any other ID, such as a tool request's.
 */
export function buttonCommand(actionId: string): InboundCommand | null {
  if (!actionId.startsWith('/')) return null;
  const [name = '', ...rest] = actionId.slice(1).split(' ');
  return { name: name.toLowerCase(), args: rest.join(' ').trim() };
}
