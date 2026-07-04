import { Database } from 'duckdb-async';
import path from 'path';

// ponytail: 單一 DB 連線，read-only 開啟 clean.parquet。分析型工具無並發寫入需求。
const PARQUET = path.join(process.cwd(), '..', 'clean.parquet');

let dbPromise: Promise<Database> | null = null;
async function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.create(':memory:');
  return dbPromise;
}

// 參數化查詢：所有使用者輸入走 prepared params，杜絕 SQL injection
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const db = await getDb();
  const rows = await db.all(sql, ...params);
  return rows as T[];
}

// 讓 SQL 直接讀 parquet 檔（DuckDB 語法）
export function src(): string {
  return `read_parquet('${PARQUET.replace(/'/g, "''")}')`;
}
