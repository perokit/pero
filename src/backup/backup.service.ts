import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Database from 'better-sqlite3';
import type { DataSource } from 'typeorm';
import { ConflictError, InvalidInputError } from '../common/errors.js';
import { PACKAGE_VERSION } from '../common/package-version.js';
import type { DataDirLayout } from '../config/data-dir.js';
import type { BackupResult } from '../control/protocol.js';
import {
  BACKUP_FORMAT,
  type BackupManifest,
  DATABASE_ENTRY,
  MANIFEST_ENTRY,
  SECRETS_ENTRY,
  writeBackupArchive,
} from './archive.js';

export const BACKUP_LAYOUT = Symbol('BACKUP_LAYOUT');

/** Writes backups of the data directory while the daemon runs. */
@Injectable()
export class BackupService implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Backup');
  private running: Promise<unknown> | undefined;

  constructor(
    @Inject(BACKUP_LAYOUT) private readonly layout: DataDirLayout,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Writes a backup to the absolute path `file`, replacing any file there.
   * The database is copied with SQLite's online backup API, so work still
   * in the WAL is included and writes may go on meanwhile. One backup runs
   * at a time.
   */
  async create(file: string): Promise<BackupResult> {
    if (this.running) {
      throw new ConflictError('A backup is already being written');
    }
    // Claimed before the first await, so shutdown and a second request
    // both see it.
    const work = this.checkDestination(file).then((destination) =>
      this.write(destination),
    );
    this.running = work;
    try {
      return await work;
    } finally {
      this.running = undefined;
    }
  }

  /** Lets a backup in progress finish before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  private async write(file: string): Promise<BackupResult> {
    const staging = await mkdtemp(join(tmpdir(), 'pero-backup-'));
    try {
      const snapshot = join(staging, DATABASE_ENTRY);
      await this.connection().backup(snapshot);
      await chmod(snapshot, 0o600);
      // A workspace keeps its token in .env, which is never backed up.
      const secrets =
        this.layout.workspace === null
          ? await copySecrets(this.layout.secrets, join(staging, SECRETS_ENTRY))
          : [];
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        peroVersion: PACKAGE_VERSION,
        createdAt: new Date().toISOString(),
        sourceDataDir: this.layout.root,
        ...describeSnapshot(snapshot),
        secrets,
      };
      await writeFile(
        join(staging, MANIFEST_ENTRY),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await writeBackupArchive(staging, file);

      const { size } = await stat(file);
      this.logger.log(`Backup written to ${file} (${size} bytes)`);
      return {
        file,
        createdAt: manifest.createdAt,
        bytes: size,
        includesSecrets: secrets.length > 0,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async checkDestination(file: string): Promise<string> {
    if (!isAbsolute(file)) {
      throw new InvalidInputError(
        `Backup file ${file} must be an absolute path`,
      );
    }
    const destination = resolve(file);
    const inside = relative(this.layout.root, destination);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      throw new InvalidInputError(
        `Backup file ${destination} must be outside the data directory ${this.layout.root}`,
      );
    }
    const parent = dirname(destination);
    const isDirectory = await stat(parent).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (!isDirectory) {
      throw new InvalidInputError(`Folder ${parent} does not exist`);
    }
    const existing = await stat(destination).catch(() => undefined);
    if (existing?.isDirectory()) {
      throw new InvalidInputError(`${destination} is a folder`);
    }
    return destination;
  }

  /** The better-sqlite3 connection TypeORM holds. */
  private connection(): Database.Database {
    return (
      this.dataSource.driver as unknown as {
        databaseConnection: Database.Database;
      }
    ).databaseConnection;
  }
}

/**
 * Reads what the manifest records from the snapshot itself, so it matches
 * the backed-up records exactly, and leaves the snapshot as one standalone
 * file without a WAL.
 */
function describeSnapshot(
  snapshot: string,
): Pick<BackupManifest, 'lastMigration' | 'workingDirectories'> {
  const db = new Database(snapshot);
  try {
    db.pragma('journal_mode = DELETE');
    const migration = db
      .prepare<[], { name: string }>(
        'SELECT "name" FROM "migrations" ORDER BY "timestamp" DESC LIMIT 1',
      )
      .get();
    const settings = db
      .prepare<[], { folder: string | null }>(
        'SELECT "default_working_directory" AS "folder" FROM "settings"',
      )
      .get();
    const agents = db
      .prepare<[], { name: string; folder: string }>(
        'SELECT "name", "working_directory" AS "folder" FROM "agents" ' +
          'WHERE "working_directory" IS NOT NULL ORDER BY "name"',
      )
      .all();
    return {
      lastMigration: migration?.name ?? null,
      workingDirectories: [
        ...(settings?.folder ? [{ path: settings.folder, agent: null }] : []),
        ...agents.map(({ name, folder }) => ({ path: folder, agent: name })),
      ],
    };
  } finally {
    db.close();
  }
}

/** Copies the regular files in `from` owner-only and returns their names. */
async function copySecrets(from: string, to: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // Leftovers of an interrupted atomic write are not secrets.
  const names = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) return [];
  await mkdir(to, { mode: 0o700 });
  for (const name of names) {
    await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
  }
  return names;
}
