// Starter content for a newly created Base — deliberately as close to nothing
// as a usable grid can be: ONE column and ONE empty row.
//
// It used to seed four opinionated columns (Nama/Catatan/Status/Tanggal) and
// three rows. That guessed at what the user was building and then made them
// delete the guess: the Status column even arrived pre-filled with three
// option values, and the grid opened grouped under "Belum diisi (3)", which
// reads like the table already has content in it. A blank base should look
// blank.
// Field/View/record JSON shapes mirror client/src/components/LarkBase/types.ts.

import { randomUUID } from 'crypto';

const uid = (p: string) => p + randomUUID().slice(0, 8);

export interface SeedTable {
  id: string; name: string; icon: string;
  fields: unknown[]; views: unknown[];
  records: { id: string; cells: Record<string, unknown>; orderIndex: number }[];
}

export function buildEmptyTables(): SeedTable[] {
  // A grid needs at least one column to render a row against, and at least
  // one row to be typeable into — one of each is the floor, not a choice.
  // Named "Judul" (title) because the first column is a record's label in
  // every table, whatever the table turns out to be about.
  const fields = [{ id: 'f_judul', name: 'Judul', type: 'text', width: 240 }];
  const views = [
    { id: uid('viw'), name: 'Grid', type: 'grid', filters: [], sorts: [], hidden: [], rowHeight: 'short' },
  ];
  const records = [{ id: uid('rec'), orderIndex: 0, cells: {} as Record<string, unknown> }];
  return [{ id: uid('tbl'), name: 'Tabel 1', icon: '📋', fields, views, records }];
}
