// Tiny in-memory fake of @supabase/supabase-js, sized just for the worker
// tests. Mirrors the patterns in the parent repo's tests/fakes/fake-supabase.ts.

import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;

interface PgError {
  message: string;
}

interface QueryResult<T> {
  data: T;
  error: PgError | null;
}

class QueryBuilder {
  private filters: Array<(r: Row) => boolean> = [];
  private orderField: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private upsertOnConflict: string[] = [];
  private selectAfter = false;
  private selectColumns: string[] | '*' = '*';

  constructor(private readonly db: FakeDb, private readonly table: string) {}

  select(cols: string = '*'): this {
    this.selectAfter = true;
    this.selectColumns = cols === '*' ? '*' : cols.split(',').map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean);
    return this;
  }
  insert(payload: Row | Row[]): this { this.op = 'insert'; this.payload = payload; return this; }
  update(payload: Row): this { this.op = 'update'; this.payload = payload; return this; }
  upsert(payload: Row | Row[], options: { onConflict?: string } = {}): this {
    this.op = 'upsert';
    this.payload = payload;
    this.upsertOnConflict = (options.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this;
  }
  delete(): this { this.op = 'delete'; return this; }

  eq(field: string, value: unknown): this { this.filters.push((r) => r[field] === value); return this; }
  neq(field: string, value: unknown): this { this.filters.push((r) => r[field] !== value); return this; }
  in(field: string, values: unknown[]): this { this.filters.push((r) => values.includes(r[field])); return this; }
  is(field: string, value: null): this { this.filters.push((r) => r[field] === value); return this; }
  lt(field: string, value: unknown): this {
    this.filters.push((r) => {
      const av = r[field];
      if (av === null || av === undefined) return false;
      return (av as string | number) < (value as string | number);
    });
    return this;
  }
  order(field: string, options: { ascending?: boolean } = {}): this {
    this.orderField = field;
    this.orderAsc = options.ascending ?? true;
    return this;
  }
  limit(n: number): this { this.limitN = n; return this; }

  private match(): Row[] {
    const all = this.db.tableRows(this.table);
    let rows = all.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderField) {
      const f = this.orderField;
      rows = [...rows].sort((a, b) => {
        const av = a[f];
        const bv = b[f];
        if (av === bv) return 0;
        const cmp = (av as number) < (bv as number) ? -1 : 1;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private projection(rows: Row[]): Row[] {
    if (this.selectColumns === '*') return rows.map((r) => ({ ...r }));
    return rows.map((r) => {
      const out: Row = {};
      for (const c of this.selectColumns as string[]) out[c] = r[c];
      return out;
    });
  }

  async maybeSingle<T = Row>(): Promise<QueryResult<T | null>> {
    const r = await this.execute();
    if (r.error) return { data: null, error: r.error };
    const rows = (r.data as Row[]) ?? [];
    if (rows.length === 0) return { data: null, error: null };
    return { data: rows[0] as unknown as T, error: null };
  }
  async single<T = Row>(): Promise<QueryResult<T | null>> {
    const r = await this.execute();
    if (r.error) return { data: null, error: r.error };
    const rows = (r.data as Row[]) ?? [];
    if (rows.length === 0) return { data: null, error: { message: 'no rows' } };
    return { data: rows[0] as unknown as T, error: null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: (value: QueryResult<Row[]>) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled as never, onrejected as never);
  }

  private async execute(): Promise<QueryResult<Row[]>> {
    if (this.op === 'select') {
      const rows = this.match();
      return { data: this.projection(rows), error: null };
    }
    if (this.op === 'insert') {
      const inserted = this.db.insert(this.table, this.payload!);
      return { data: this.selectAfter ? this.projection(inserted) : inserted, error: null };
    }
    if (this.op === 'update') {
      // CRITICAL for lease tests: filters apply at the moment of update so
      // a second worker reading stale state can't sneak through.
      const matched = this.match();
      const updated = this.db.updateRows(this.table, matched, this.payload as Row);
      return { data: this.selectAfter ? this.projection(updated) : updated, error: null };
    }
    if (this.op === 'upsert') {
      const result = this.db.upsert(this.table, this.payload!, this.upsertOnConflict);
      return { data: this.selectAfter ? this.projection(result) : result, error: null };
    }
    if (this.op === 'delete') {
      const matched = this.match();
      this.db.deleteRows(this.table, matched);
      return { data: matched, error: null };
    }
    return { data: [], error: { message: 'unknown op' } };
  }
}

export class FakeDb {
  private tables = new Map<string, Row[]>();

  tableRows(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }
  seedTable(name: string, rows: Row[]): void {
    this.tables.set(name, rows.map((r) => ({ ...r })));
  }
  insert(table: string, payload: Row | Row[]): Row[] {
    const rows = this.tableRows(table);
    const arr = Array.isArray(payload) ? payload : [payload];
    const inserted = arr.map((p) => {
      const row: Row = { id: randomUUID(), created_at: new Date().toISOString(), ...p };
      rows.push(row);
      return row;
    });
    return inserted;
  }
  updateRows(_table: string, matched: Row[], patch: Row): Row[] {
    for (const r of matched) Object.assign(r, patch);
    return matched.map((r) => ({ ...r }));
  }
  deleteRows(table: string, matched: Row[]): void {
    const rows = this.tableRows(table);
    for (const m of matched) {
      const idx = rows.indexOf(m);
      if (idx >= 0) rows.splice(idx, 1);
    }
  }
  upsert(table: string, payload: Row | Row[], onConflict: string[]): Row[] {
    const arr = Array.isArray(payload) ? payload : [payload];
    const rows = this.tableRows(table);
    const out: Row[] = [];
    for (const p of arr) {
      const existing = onConflict.length > 0
        ? rows.find((r) => onConflict.every((k) => r[k] === p[k]))
        : undefined;
      if (existing) {
        Object.assign(existing, p);
        out.push(existing);
      } else {
        const row: Row = { id: randomUUID(), ...p };
        rows.push(row);
        out.push(row);
      }
    }
    return out.map((r) => ({ ...r }));
  }
}

export class FakeSupabaseClient {
  constructor(public readonly db: FakeDb) {}
  from(table: string): QueryBuilder { return new QueryBuilder(this.db, table); }
}
