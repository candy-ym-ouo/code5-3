import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.ts';

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(samples)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'slot')) {
      this.db.exec('ALTER TABLE samples ADD COLUMN slot INTEGER NOT NULL DEFAULT 1');
    }

    // 环境记录校准：旧记录保留原口径（v1）与原分数，新记录写入 v2 校准明细。
    const observationColumns = this.db
      .prepare('PRAGMA table_info(observations)')
      .all() as unknown as Array<{ name: string }>;
    if (!observationColumns.some((column) => column.name === 'score_version')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN score_version TEXT NOT NULL DEFAULT 'v1'`);
    }
    if (!observationColumns.some((column) => column.name === 'calibration_json')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN calibration_json TEXT NOT NULL DEFAULT ''`);
    }
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
