import { Base, Table, Field, BaseRecord, View, SelectOption } from './types';

// Deterministic-ish ids for the seed so cells line up with fields. Real
// tables use uid(); the seed hard-codes readable ids for clarity.
const opt = (id: string, name: string, color: string): SelectOption => ({ id, name, color });

// Anchor dates to the CURRENT month so the Calendar view has visible entries
// out of the box. Local midday to avoid any tz day-shift at the edges.
const now = new Date();
const day = (d: number) => new Date(now.getFullYear(), now.getMonth(), d, 10, 0, 0).getTime();

function meetingsTable(): Table {
  const fields: Field[] = [
    { id: 'f_judul', name: 'Judul Rapat', type: 'text', width: 240 },
    { id: 'f_agenda', name: 'Agenda', type: 'longText', width: 280 },
    { id: 'f_tanggal', name: 'Tanggal', type: 'date', width: 150 },
    { id: 'f_durasi', name: 'Durasi (menit)', type: 'number', width: 140 },
    { id: 'f_rate', name: 'Rate / jam', type: 'currency', width: 160 },
    {
      id: 'f_status', name: 'Status', type: 'select', width: 150,
      options: [
        opt('s_jadwal', 'Terjadwal', 'blue'),
        opt('s_jalan', 'Berlangsung', 'amber'),
        opt('s_selesai', 'Selesai', 'green'),
        opt('s_batal', 'Dibatalkan', 'red'),
      ],
    },
    {
      id: 'f_label', name: 'Label', type: 'multiSelect', width: 210,
      options: [
        opt('l_produk', 'Produk', 'purple'),
        opt('l_desain', 'Desain', 'pink'),
        opt('l_teknis', 'Teknis', 'teal'),
        opt('l_klien', 'Klien', 'orange'),
      ],
    },
    { id: 'f_pic', name: 'Penanggung Jawab', type: 'person', width: 170 },
    { id: 'f_selesai', name: 'Selesai', type: 'checkbox', width: 90 },
    { id: 'f_prioritas', name: 'Prioritas', type: 'rating', width: 140 },
    { id: 'f_rekaman', name: 'Rekaman', type: 'url', width: 220 },
    // Referensi field by NAME (the formula engine resolves {Nama Field}).
    { id: 'f_biaya', name: 'Estimasi Biaya', type: 'formula', width: 170, formula: '{Durasi (menit)} / 60 * {Rate / jam}' },
  ];

  const records: BaseRecord[] = [
    {
      id: 'r_m1',
      cells: {
        f_judul: 'Sprint Planning Q3', f_agenda: 'Tentukan scope sprint & bagi tugas tim.',
        f_tanggal: day(3), f_durasi: 90, f_rate: 250000, f_status: 's_selesai',
        f_label: ['l_produk', 'l_teknis'], f_pic: 'Rizky', f_selesai: true, f_prioritas: 4,
        f_rekaman: 'https://rec.meetkai.io/sprint-q3',
      },
    },
    {
      id: 'r_m2',
      cells: {
        f_judul: 'Design Review Landing', f_agenda: 'Review hi-fi mockup halaman utama.',
        f_tanggal: day(7), f_durasi: 60, f_rate: 300000, f_status: 's_selesai',
        f_label: ['l_desain'], f_pic: 'Sinta', f_selesai: true, f_prioritas: 3,
        f_rekaman: 'https://rec.meetkai.io/design-landing',
      },
    },
    {
      id: 'r_m3',
      cells: {
        f_judul: 'Standup Harian', f_agenda: 'Update progres & blocker.',
        f_tanggal: day(12), f_durasi: 15, f_rate: 200000, f_status: 's_jalan',
        f_label: ['l_teknis'], f_pic: 'Bagus', f_selesai: false, f_prioritas: 2,
        f_rekaman: '',
      },
    },
    {
      id: 'r_m4',
      cells: {
        f_judul: 'Demo ke Klien Nusantara', f_agenda: 'Presentasi fitur baru & tanya jawab.',
        f_tanggal: day(18), f_durasi: 120, f_rate: 400000, f_status: 's_jadwal',
        f_label: ['l_klien', 'l_produk'], f_pic: 'Rizky', f_selesai: false, f_prioritas: 5,
        f_rekaman: '',
      },
    },
    {
      id: 'r_m5',
      cells: {
        f_judul: 'Retro Sprint 12', f_agenda: 'Apa yang jalan, apa yang perlu diperbaiki.',
        f_tanggal: day(22), f_durasi: 45, f_rate: 250000, f_status: 's_jadwal',
        f_label: ['l_teknis', 'l_desain'], f_pic: 'Sinta', f_selesai: false, f_prioritas: 3,
        f_rekaman: '',
      },
    },
    {
      id: 'r_m6',
      cells: {
        f_judul: 'Sinkron Budget', f_agenda: 'Bahas anggaran kuartal berikutnya.',
        f_tanggal: day(26), f_durasi: 30, f_rate: 350000, f_status: 's_batal',
        f_label: ['l_klien'], f_pic: 'Bagus', f_selesai: false, f_prioritas: 1,
        f_rekaman: '',
      },
    },
  ];

  const views: View[] = [
    { id: 'v_m_grid', name: 'Semua Rapat', type: 'grid', filters: [], sorts: [], hidden: [], rowHeight: 'short' },
    { id: 'v_m_kanban', name: 'Papan Status', type: 'kanban', filters: [], sorts: [], hidden: [], stackField: 'f_status' },
    { id: 'v_m_gallery', name: 'Galeri', type: 'gallery', filters: [], sorts: [], hidden: [] },
    { id: 'v_m_cal', name: 'Kalender', type: 'calendar', filters: [], sorts: [], hidden: [], dateField: 'f_tanggal' },
  ];

  return { id: 'tbl_rapat', name: 'Rapat', icon: '📅', fields, records, views };
}

function actionItemsTable(): Table {
  const fields: Field[] = [
    { id: 'a_tugas', name: 'Tugas', type: 'text', width: 260 },
    { id: 'a_pic', name: 'PIC', type: 'person', width: 150 },
    { id: 'a_tenggat', name: 'Tenggat', type: 'date', width: 150 },
    {
      id: 'a_prioritas', name: 'Prioritas', type: 'select', width: 140,
      options: [
        opt('p_tinggi', 'Tinggi', 'red'),
        opt('p_sedang', 'Sedang', 'amber'),
        opt('p_rendah', 'Rendah', 'gray'),
      ],
    },
    {
      id: 'a_kategori', name: 'Kategori', type: 'multiSelect', width: 200,
      options: [
        opt('k_bug', 'Bug', 'red'),
        opt('k_fitur', 'Fitur', 'blue'),
        opt('k_riset', 'Riset', 'purple'),
      ],
    },
    { id: 'a_selesai', name: 'Selesai', type: 'checkbox', width: 90 },
    { id: 'a_progress', name: 'Progress', type: 'rating', width: 140 },
    { id: 'a_jam', name: 'Estimasi Jam', type: 'number', width: 130 },
    { id: 'a_ref', name: 'Referensi', type: 'url', width: 200 },
    { id: 'a_catatan', name: 'Catatan', type: 'longText', width: 240 },
  ];

  const records: BaseRecord[] = [
    { id: 'r_a1', cells: { a_tugas: 'Perbaiki bug login', a_pic: 'Bagus', a_tenggat: day(5), a_prioritas: 'p_tinggi', a_kategori: ['k_bug'], a_selesai: false, a_progress: 2, a_jam: 4, a_ref: 'https://git.meetkai.io/issues/210', a_catatan: 'Reproduksi di Safari.' } },
    { id: 'r_a2', cells: { a_tugas: 'Desain ikon kanban', a_pic: 'Sinta', a_tenggat: day(9), a_prioritas: 'p_sedang', a_kategori: ['k_fitur'], a_selesai: true, a_progress: 5, a_jam: 6, a_ref: '', a_catatan: '' } },
    { id: 'r_a3', cells: { a_tugas: 'Riset kompetitor', a_pic: 'Rizky', a_tenggat: day(14), a_prioritas: 'p_rendah', a_kategori: ['k_riset', 'k_fitur'], a_selesai: false, a_progress: 1, a_jam: 8, a_ref: '', a_catatan: 'Bandingkan 3 produk.' } },
    { id: 'r_a4', cells: { a_tugas: 'Optimasi query room', a_pic: 'Bagus', a_tenggat: day(20), a_prioritas: 'p_tinggi', a_kategori: ['k_bug', 'k_fitur'], a_selesai: false, a_progress: 3, a_jam: 5, a_ref: '', a_catatan: '' } },
  ];

  const views: View[] = [
    { id: 'v_a_grid', name: 'Semua Tugas', type: 'grid', filters: [], sorts: [], hidden: [], rowHeight: 'short' },
    { id: 'v_a_kanban', name: 'Papan Prioritas', type: 'kanban', filters: [], sorts: [], hidden: [], stackField: 'a_prioritas' },
    { id: 'v_a_gallery', name: 'Galeri', type: 'gallery', filters: [], sorts: [], hidden: [] },
    { id: 'v_a_cal', name: 'Kalender', type: 'calendar', filters: [], sorts: [], hidden: [], dateField: 'a_tenggat' },
  ];

  return { id: 'tbl_action', name: 'Action Item', icon: '✅', fields, records, views };
}

export function buildSeedBase(): Base {
  return { id: 'base_meetkai', name: 'Basis Data MeetKai', tables: [meetingsTable(), actionItemsTable()] };
}
