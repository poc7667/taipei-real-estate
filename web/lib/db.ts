import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import path from 'path';

// ponytail: 單一 in-memory DuckDB 連線直讀 parquet。分析工具無並發寫入。
const PARQUET = path.join(process.cwd(), '..', 'clean.parquet');

let connPromise: Promise<DuckDBConnection> | null = null;
async function getConn(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = (async () => {
      const inst = await DuckDBInstance.create(':memory:');
      return inst.connect();
    })();
  }
  return connPromise;
}

// 參數化查詢：使用者輸入一律走 prepared params，杜絕 SQL injection
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const conn = await getConn();
  const reader = params.length
    ? await conn.runAndReadAll(sql, params as never[])
    : await conn.runAndReadAll(sql);
  // DuckDB 回傳 BigInt（COUNT 等）→ JSON 無法序列化，轉成 number
  return reader.getRowObjects().map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v;
    return o;
  }) as T[];
}

// SQL 直讀 parquet
export function src(): string {
  return `read_parquet('${PARQUET.replace(/'/g, "''")}')`;
}
