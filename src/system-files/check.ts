import { join, relative } from 'node:path';
import { ConfigError, STATE_DIR_NAME } from '../config/bootstrap-config.js';
import {
  EnvFilePermissionError,
  gitEnvFileProblem,
  readEnvFile,
} from '../config/env-file.js';
import {
  DEFAULT_DATA_FOLDER,
  type HostConfig,
  DEFAULT_SPEECH,
  DEFAULT_FILES,
  hostConfigPath,
  readHostConfig,
  resolveDataFolder,
} from '../config/host-config.js';
import { validateWorkingDirectory } from '../config/working-directory.js';
import { loadSystemFolder } from './load.js';
import type { TopicLookup } from './snapshot.js';

// Shared by the CLI and the daemon. Keep this free of Nest and TypeORM imports.

/** One problem `pero check` found. */
export interface CheckProblem {
  /** The file at fault, relative to the workspace. */
  file: string;
  /** The property or key at fault; null for the whole file. */
  property: string | null;
  message: string;
}

/** What `pero check` found in a workspace. */
export interface WorkspaceCheck {
  /**
   * The system folder, relative to the workspace when inside it; null
   * when `config.yaml` is invalid, and the notes were not checked.
   */
  systemFolder: string | null;
  /** How many Channel notes and Workflows loaded. */
  channels: number;
  workflows: number;
  /** Whether Channel references were checked against the Channels Pero has seen. */
  topicsChecked: boolean;
  /** `config.yaml`'s first, then `.env`'s, then the notes' by file. */
  problems: CheckProblem[];
}

export interface CheckWorkspaceInput {
  /** Absolute path of the workspace. */
  workspace: string;
  homeDir: string;
  hostTimeZone: string;
  /** Without one, Channel references are checked without Pero's database. */
  topics?: TopicLookup;
}

/**
 * Checks everything Pero reads from `workspace` without opening its
 * database: `config.yaml`, how `.env` is protected, and every note in the
 * system folder. It changes nothing.
 */
export async function checkWorkspace(
  input: CheckWorkspaceInput,
): Promise<WorkspaceCheck> {
  const { workspace, homeDir } = input;
  const shown = (path: string) => {
    const inside = relative(workspace, path);
    return inside.startsWith('..') ? path : inside;
  };
  const problems: CheckProblem[] = [];
  const configFile = hostConfigPath(join(workspace, STATE_DIR_NAME));
  const configShown = shown(configFile);

  let config: HostConfig | null;
  try {
    config = readHostConfig(configFile) ?? {
      data: null,
      system: null,
      allowedChats: [],
      speech: DEFAULT_SPEECH,
      files: DEFAULT_FILES,
    };
  } catch (error) {
    config = null;
    // `Invalid <file>:`, then one indented line for each problem.
    const lines =
      error instanceof ConfigError
        ? error.message.split('\n').slice(1)
        : [describe(error)];
    for (const line of lines) {
      problems.push({
        file: configShown,
        property: null,
        message: line.trim(),
      });
    }
  }
  if (config !== null && config.data !== null) {
    // Startup creates the default `data/`; a folder named here must exist.
    const folder = resolveDataFolder(config, workspace, homeDir);
    if (folder !== join(workspace, DEFAULT_DATA_FOLDER)) {
      try {
        await validateWorkingDirectory(folder);
      } catch (error) {
        problems.push({
          file: configShown,
          property: 'data',
          message: describe(error),
        });
      }
    }
  }

  const envFile = join(workspace, '.env');
  try {
    readEnvFile(envFile);
  } catch (error) {
    if (!(error instanceof EnvFilePermissionError)) throw error;
    problems.push({
      file: shown(envFile),
      property: null,
      message: `readable by other users; run chmod 600 ${error.path}`,
    });
  }
  const git = await gitEnvFileProblem(workspace);
  if (git !== null) {
    problems.push({ file: shown(envFile), property: null, message: git });
  }

  if (config === null) {
    return {
      systemFolder: null,
      channels: 0,
      workflows: 0,
      topicsChecked: false,
      problems,
    };
  }
  const { systemFolder, snapshot } = await loadSystemFolder({
    workspace,
    config,
    homeDir,
    hostTimeZone: input.hostTimeZone,
    ...(input.topics === undefined ? {} : { topics: input.topics }),
  });
  for (const error of snapshot.errors) {
    problems.push({ ...error, file: shown(join(systemFolder, error.file)) });
  }
  return {
    systemFolder: shown(systemFolder),
    channels: snapshot.channelNotes.size,
    workflows: snapshot.workflows.size,
    topicsChecked: input.topics !== undefined,
    problems,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
