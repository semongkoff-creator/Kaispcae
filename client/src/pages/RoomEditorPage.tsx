import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowCounterclockwise, ArrowClockwise } from 'react-bootstrap-icons';
import {
  TILE_SIZE, MAP_WIDTH, MAP_HEIGHT, RoomTile, Furniture, Zone, RoomTheme,
  LayerData, TileEffect, AreaEffect, legacyToLayerData, CustomAssetEntry, ReferenceImageData, InteractiveObjectType, TriggerMethod,
  AVATAR_SCALE_MIN, AVATAR_SCALE_MAX,
} from '@virtualmeet/shared';
import { api, ApiError } from '@/services/api';
import { adminApi } from '@/admin/api';
import { useEditorStore, EDITOR_LAYERS, EDITOR_TOOLS, EditorLayer, EditorTool } from '@/stores/editorStore';
import { drawFloorTile, drawWallTile, drawFurnitureLayer } from '@/components/canvas/mapRender';
import { drawSpriteFrame, getSpriteImage } from '@/utils/spriteLoader';
import { disableImageSmoothing } from '@/utils/canvasSharpness';
import { PALETTE_BY_THEME, PALETTE_BY_ID } from '@/data/themeAssets';
import { PaletteEntry } from '@/data/tilePaletteManifest';
import { LIMEZU_CATEGORIES, loadLimezuCategory } from '@/data/limezuInteriors';
import { registerCustomAssets } from '@/data/customAssets';

// ZEP-style Room Editor — Potong 3. Adds Wall (tile → collision), Objects
// (below avatar) and Top objects (above avatar) editing to the Potong 2 floor
// tools. Wall stamps become impassable live via the Potong-1 adaptor. Objects
// carry their catalog interactivity (sittable → isInteractable). Edits save +
// broadcast through the same path as Potong 2. Tile effects stay Potong 4.

type LoadError = 'auth' | 'forbidden' | 'notfound' | 'generic';
const OBJ_CATEGORIES: { key: 'furniture' | 'decor' | 'electronics'; label: string }[] = [
  { key: 'furniture', label: 'Furniture' }, { key: 'decor', label: 'Decor' }, { key: 'electronics', label: 'Electronics' },
];
const EFFECTS: { id: 'startingPoint' | 'impassable' | 'mapLocation' | 'privateArea' | 'impassableArea' | 'focusArea' | 'meetingArea' | 'wallArea' | 'portal' | 'door' | 'sittable' | 'claimableSeat' | 'restrictedArea' | 'doorArea'; label: string; color: string; hint: string }[] = [
  { id: 'startingPoint', label: 'Starting point', color: 'rgba(16,185,129,0.9)', hint: 'Stamp per tile = titik spawn (bisa banyak; pemain muncul di salah satunya).' },
  { id: 'impassable', label: 'Impassable', color: 'rgba(239,68,68,0.85)', hint: 'Stamp per tile = penghalang tak terlihat (memblok gerak, tanpa tekstur).' },
  { id: 'impassableArea', label: 'Impassable Area', color: 'rgba(220,38,38,0.6)', hint: 'Drag di area kosong = buat area kotak baru, ukuran bebas (tidak ikut grid). Klik area yang sudah ada = pilih (muncul handle) — drag badan untuk pindah, tarik pojok/sisi untuk resize, Delete untuk hapus. Saat main, penghalangnya tetap memblok tile penuh mana pun yang tersentuh kotak ini — invisible, sama seperti Impassable per-tile.' },
  { id: 'wallArea', label: 'Wall Area', color: 'rgba(55,65,81,0.9)', hint: 'Sama seperti Impassable Area (drag = buat, klik = pilih/resize/pindah, Delete = hapus, ukuran bebas), TAPI kelihatan pas main — digambar abu-abu gelap bergaris kuning, bukan invisible. Pas buat tembok/partisi yang jelas keliatan menghalangi.' },
  { id: 'mapLocation', label: 'Map location', color: 'rgba(192,132,252,0.95)', hint: 'Stamp: drag area lalu beri nama → pill label muncul di game. Bisa pilih kedap suara atau tidak (default: tidak, jarak biasa).' },
  { id: 'privateArea', label: 'Private area', color: 'rgba(96,165,250,0.95)', hint: 'Stamp: drag area + Area ID. Area ber-ID sama = satu grup audio (walau terpisah). Bisa pilih kedap suara atau tidak (default: kedap suara).' },
  { id: 'focusArea', label: 'Focus area', color: 'rgba(245,158,11,0.95)', hint: 'Drag area lalu beri nama. Pemain yang masuk otomatis berstatus Focus + DND (tidak bisa disummon/slap/di-follow, tidak auto-connect proximity), bisa nyetel musik privat sendiri, dan channel chat "Fokus" otomatis kebuka. Visual area tetap normal, tidak digelapkan.' },
  { id: 'meetingArea', label: 'Meeting area', color: 'rgba(20,184,166,0.95)', hint: 'Drag area lalu beri nama. Pemain yang masuk otomatis berstatus "In a meeting" dan bicara lewat voice/video jarak-dekat. Bisa pilih kedap suara atau tidak (default: kedap suara, seperti rapat sungguhan).' },
  { id: 'restrictedArea', label: 'Restricted area', color: 'rgba(220,38,38,0.85)', hint: 'Drag area lalu beri nama (mis. "CEO Office") — hanya ADMIN yang bisa langsung masuk. Orang lain yang menyentuh area ini langsung disodori form antrean "Ngobrol dengan CEO" untuk dapat giliran masuk sendiri.' },
  { id: 'portal', label: 'Portal', color: 'rgba(124,58,237,0.95)', hint: 'Stamp klik tile portal → pilih tujuan room lain, atau klik titik tujuan di room ini. Pemain tekan F untuk pindah.' },
  { id: 'door', label: 'Door', color: 'rgba(212,160,86,0.9)', hint: 'Stamp per tile = pintu yang bisa dilewati. Pilih tool Select lalu klik pintu untuk atur Password (opsional, mirip ZEP).' },
  { id: 'doorArea', label: 'Door Area', color: 'rgba(212,160,86,0.6)', hint: 'Sama seperti Impassable Area (drag = buat, klik = pilih/resize/pindah, Delete = hapus, ukuran bebas), TAPI hanya memblok kalau Password diaktifkan dan belum dibuka. Klik area yang sudah dibuat untuk atur Password, Deskripsi, Pesan gagal, dan cara memicu (otomatis saat masuk area, atau tekan F dulu).' },
  { id: 'sittable', label: 'Sittable', color: 'rgba(56,189,248,0.9)', hint: 'Stamp per tile = kursi tanpa objek (mis. kursi yang cuma gambar di reference image). Pilih tool Select lalu klik tile untuk atur arah hadap.' },
  { id: 'claimableSeat', label: 'Kursi Diklaim', color: 'rgba(250,204,21,0.95)', hint: 'Stamp per tile = titik kursi yang bisa DIKLAIM pemain saat main (nama pemilik muncul realtime, klik kursi sendiri buat teleport ke situ). Pindahkan = Eraser lalu Stamp di posisi baru.' },
];

interface MediaObj { id: string; type: string; x: number; y: number; payload: { url?: string; videoId?: string; websiteUrl?: string; audioUrl?: string; areaW?: number; areaH?: number; name?: string } }
function parseYouTubeId(raw: string): string | null {
  const m = raw.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || raw.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}
function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files?.[0] ?? null); i.click(); });
}

type SavePayload = ReturnType<ReturnType<typeof useEditorStore.getState>['takePending']>;
function hasChanges(p: SavePayload): boolean {
  // referenceImage can legitimately be `null` (an explicit clear) — a plain
  // truthy check would miss that and silently drop the save, same class of
  // bug a naive `|| p.referenceImage` would have here.
  return !!(p.floorChanges?.length || p.wallChanges?.length || p.objects || p.topObjects || p.tileEffects || p.areas || p.customAssets || p.width != null || 'referenceImage' in p);
}

function normalizeTiles(tilemapData: unknown[][] | null): RoomTile[][] {
  if (Array.isArray(tilemapData) && tilemapData.length > 0) {
    return tilemapData.map((row, y) =>
      (row as Record<string, unknown>[]).map((t, x) => ({ ...(t as object), x, y, type: (t as { type?: string }).type || 'floor' } as RoomTile)),
    );
  }
  return Array.from({ length: MAP_HEIGHT }, (_, y) => Array.from({ length: MAP_WIDTH }, (_, x) => ({ x, y, type: 'floor' } as RoomTile)));
}

// Small canvas thumbnail of a palette piece (handles multi-tile furniture),
// retrying briefly until the sprite sheet has loaded.
function PieceThumb({ paletteId, size = 40 }: { paletteId: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const entry = PALETTE_BY_ID[paletteId];
    if (!entry) return;
    let n = 0, raf = 0;
    const draw = () => {
      const c = ref.current; const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      // No dpr scaling here previously — the backing store was `size` physical
      // px regardless of screen density, so this thumbnail (unlike the main
      // canvas/palette CSS thumbnails elsewhere in this file) came out
      // upscaled-and-blurred on Retina/HiDPI displays.
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== size * dpr || c.height !== size * dpr) {
        c.width = size * dpr;
        c.height = size * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wPx = (entry.tilesW || 1) * 32, hPx = (entry.tilesH || 1) * 32;
      const scale = Math.min(size / wPx, size / hPx);
      const dw = wPx * scale, dh = hPx * scale;
      ctx.clearRect(0, 0, size, size);
      disableImageSmoothing(ctx);
      const drew = drawSpriteFrame(ctx, entry.src, { srcX: entry.srcX, srcY: entry.srcY, cellWidth: wPx, cellHeight: hPx, dx: (size - dw) / 2, dy: (size - dh) / 2, dWidth: dw, dHeight: dh });
      if (!drew && n++ < 60) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [paletteId, size]);
  return <canvas ref={ref} style={{ width: size, height: size, imageRendering: 'pixelated' }} className="block" />;
}

// Fitur 15B — ZEP-style "Object Settings" panel: shown instead of the
// palette grid while a placed piece is selected (Select tool). Rotate&Flip/
// Size/Reposition are generic to any piece; the Type dropdown below them is
// the Interactive Object system — only 'text_popup' is wired up so far
// (more of ZEP's pop-up/website/developer types land incrementally).
function ObjectSettingsPanel({
  furniture, layer, slug, onBack,
}: {
  furniture: Furniture | null;
  layer: 'objects' | 'top';
  slug: string;
  onBack: () => void;
}) {
  const [imgBusy, setImgBusy] = useState(false);
  const [imgErr, setImgErr] = useState('');
  const [spriteBusy, setSpriteBusy] = useState(false);
  const [spriteErr, setSpriteErr] = useState('');
  if (!furniture) return null;
  const patch = (p: Partial<Furniture>) => useEditorStore.getState().updateSelectedObject(p, layer);
  const rotation = furniture.rotation ?? 0;
  const sizeW = furniture.sizePercent?.w ?? 100;
  const sizeH = furniture.sizePercent?.h ?? 100;
  const offX = furniture.offsetPx?.x ?? 0;
  const offY = furniture.offsetPx?.y ?? 0;
  const interactiveType = furniture.interactiveType;

  const pickImage = async () => {
    const f = await pickFile('image/png,image/jpeg');
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setImgErr('Gambar maksimal 10MB.'); return; }
    setImgBusy(true); setImgErr('');
    try {
      const { url } = await api.uploadMedia(f, slug);
      patch({ interactiveConfig: { ...furniture.interactiveConfig, imageUrl: url } });
    } catch {
      setImgErr('Gagal upload gambar. Coba lagi.');
    } finally {
      setImgBusy(false);
    }
  };

  const pickSprite = async () => {
    const f = await pickFile('image/png,image/jpeg');
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setSpriteErr('Gambar maksimal 10MB.'); return; }
    setSpriteBusy(true); setSpriteErr('');
    try {
      const { url } = await api.uploadMedia(f, slug);
      patch({ interactiveConfig: { ...furniture.interactiveConfig, spriteFile: url } });
    } catch {
      setSpriteErr('Gagal upload gambar. Coba lagi.');
    } finally {
      setSpriteBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={onBack} title="Kembali ke palette" className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center cursor-pointer text-white/70">←</button>
        <p className="text-xs uppercase tracking-wider text-white/40">Object Settings</p>
      </div>

      <p className="text-[11px] text-white/50 mb-1.5">Type</p>
      <select
        value={interactiveType ?? ''}
        onChange={(e) => {
          const v = e.target.value as InteractiveObjectType | '';
          if (!v) { patch({ interactiveType: undefined, interactiveConfig: undefined, triggerRange: undefined, triggerMethod: undefined }); return; }
          const cfg = furniture.interactiveConfig ?? {};
          // Multiple choice needs at least one option to have anywhere to
          // mark "Correct" — seed two blank ones the first time this type is
          // picked, same as ZEP's own default of Option 1/Option 2.
          const seeded = v === 'multiple_choice' && !cfg.options?.length
            ? { ...cfg, options: [{ text: '', isCorrect: true }, { text: '', isCorrect: false }] }
            : cfg;
          patch({ interactiveType: v, triggerRange: furniture.triggerRange ?? 1, triggerMethod: furniture.triggerMethod ?? 'press_f', interactiveConfig: seeded });
        }}
        className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white cursor-pointer outline-none"
      >
        <option value="">— Furniture biasa —</option>
        <option value="text_popup">Text pop-up</option>
        <option value="image_popup">Image pop-up</option>
        <option value="website">Open website in a new window</option>
        <option value="website_tab">Open website in a new tab</option>
        <option value="password">Password prompt</option>
        <option value="multiple_choice">Multiple choice pop-up</option>
        <option value="api_call">API call (POST)</option>
        <option value="show_name">Show object name</option>
        <option value="show_word_balloon">Show word balloons</option>
        <option value="change_object">Change object</option>
        <option value="animation">Animation functions</option>
      </select>

      <p className="text-[11px] text-white/50 mb-1.5">Name</p>
      <input
        type="text" value={furniture.name ?? ''} onChange={(e) => patch({ name: e.target.value || undefined })}
        placeholder="Please enter the object name"
        className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
      />
      <label className="flex items-center gap-2 text-[11px] text-white/60 mb-3 cursor-pointer">
        <input type="checkbox" checked={!!furniture.hideObjectName} onChange={(e) => patch({ hideObjectName: e.target.checked || undefined })} />
        Hide object name
      </label>

      {interactiveType === 'show_name' && (
        <p className="text-[11px] text-white/40 mb-3">Trigger akan menampilkan isi field Name di atas sebagai label mengambang. Kosong = tidak ada yang ditampilkan.</p>
      )}

      {interactiveType === 'show_word_balloon' && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Word Balloon Type</p>
          <div className="space-y-1 mb-3">
            {([['default', 'Default'], ['random', 'Random']] as const).map(([id, label]) => (
              <label key={id} className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                <input type="radio" checked={(furniture.interactiveConfig?.wordBalloonType ?? 'default') === id} onChange={() => patch({ interactiveConfig: { ...furniture.interactiveConfig, wordBalloonType: id } })} />
                {label}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-white/50 mb-1.5">Word Balloon Text</p>
          <textarea
            value={furniture.interactiveConfig?.wordBalloonText ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, wordBalloonText: e.target.value } })}
            rows={2}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white resize-none outline-none focus:border-purple-400"
          />
        </>
      )}

      {interactiveType === 'change_object' && (
        <>
          <p className="text-[11px] text-white/40 mb-1.5">Remove or replace object when the user approaches or interacts with it.</p>
          <p className="text-[11px] text-white/50 mb-1.5">After Action</p>
          <select
            value={furniture.interactiveConfig?.afterAction ?? 'disappear'}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, afterAction: e.target.value as 'disappear' } })}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white cursor-pointer outline-none"
          >
            <option value="disappear">Object disappears</option>
          </select>
          <p className="text-[11px] text-white/40 mb-3">Trigger oleh SIAPA SAJA akan menghapus objek ini permanen dari map, untuk semua pemain — bukan cuma yang trigger.</p>
        </>
      )}

      {interactiveType === 'animation' && (
        <>
          <p className="text-[11px] text-white/40 mb-1.5">Implement moving objects through sprite files. Saat trigger, sprite ini muncul sebagai animasi mengambang di atas objek selama beberapa detik.</p>
          <p className="text-[11px] text-white/50 mb-1.5">Image Sprite File</p>
          <button onClick={pickSprite} disabled={spriteBusy} className="w-full mb-1.5 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white/80 text-xs cursor-pointer">
            {spriteBusy ? 'Mengupload…' : 'Select file'}
          </button>
          {spriteErr && <p className="text-red-400 text-[11px] mb-1.5">{spriteErr}</p>}
          {furniture.interactiveConfig?.spriteFile && (
            <p className="text-[11px] text-white/40 mb-1.5 truncate">{furniture.interactiveConfig.spriteFile}</p>
          )}
          <div className="flex items-center gap-2 mb-1.5">
            <label className="flex-1 text-[10px] text-white/40">Image Width (px)<input type="number" value={furniture.interactiveConfig?.spriteFrameWidth ?? ''} onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, spriteFrameWidth: Number(e.target.value) || undefined } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
            <label className="flex-1 text-[10px] text-white/40">Image Height (px)<input type="number" value={furniture.interactiveConfig?.spriteFrameHeight ?? ''} onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, spriteFrameHeight: Number(e.target.value) || undefined } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
          </div>
          <p className="text-[11px] text-white/50 mb-1.5">Frame Number</p>
          <input
            type="number" min={1} value={furniture.interactiveConfig?.spriteFrameCount ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, spriteFrameCount: Math.max(1, Number(e.target.value) || 1) } })}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none"
          />
        </>
      )}

      {interactiveType === 'text_popup' && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Text</p>
          <textarea
            value={furniture.interactiveConfig?.text ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, text: e.target.value } })}
            rows={3}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white resize-none outline-none focus:border-purple-400"
          />
        </>
      )}

      {interactiveType === 'image_popup' && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Image File</p>
          <button onClick={pickImage} disabled={imgBusy} className="w-full mb-1.5 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white/80 text-xs cursor-pointer">
            {imgBusy ? 'Mengupload…' : 'Select file'}
          </button>
          {imgErr && <p className="text-red-400 text-[11px] mb-1.5">{imgErr}</p>}
          {furniture.interactiveConfig?.imageUrl && (
            <div className="mb-3 rounded border border-white/10 overflow-hidden bg-black/20">
              <img
                key={furniture.interactiveConfig.imageUrl}
                src={furniture.interactiveConfig.imageUrl}
                alt=""
                className="w-full max-h-32 object-contain"
                // Same diagnosability gap as the in-game popup (see
                // InteractiveObjectModal's PopupImage) — a saved imageUrl that
                // fails to load silently showed nothing here either, so the
                // admin had no signal something was wrong before a player
                // ever hit the same broken URL in-game.
                onError={() => setImgErr('URL gambar tersimpan tidak bisa dimuat (cek koneksi/storage).')}
              />
            </div>
          )}
        </>
      )}

      {(interactiveType === 'website' || interactiveType === 'website_tab') && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Website Link</p>
          <input
            type="text" value={furniture.interactiveConfig?.url ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, url: e.target.value } })}
            placeholder="https://…"
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/40 mb-2">Harus https:// — URL lain akan ditolak saat disimpan.</p>
          {interactiveType === 'website' && (
            <>
              <div className="space-y-1 mb-2">
                <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                  <input type="radio" checked={furniture.interactiveConfig?.fullscreen !== false} onChange={() => patch({ interactiveConfig: { ...furniture.interactiveConfig, fullscreen: true } })} />
                  Open fullscreen
                </label>
                <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                  <input type="radio" checked={furniture.interactiveConfig?.fullscreen === false} onChange={() => patch({ interactiveConfig: { ...furniture.interactiveConfig, fullscreen: false } })} />
                  Set size
                </label>
              </div>
              {furniture.interactiveConfig?.fullscreen === false && (
                <div className="flex items-center gap-2 mb-3">
                  <label className="flex-1 text-[10px] text-white/40">Width (px)<input type="number" value={furniture.interactiveConfig?.width ?? ''} onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, width: Number(e.target.value) || undefined } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
                  <label className="flex-1 text-[10px] text-white/40">Height (px)<input type="number" value={furniture.interactiveConfig?.height ?? ''} onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, height: Number(e.target.value) || undefined } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
                </div>
              )}
            </>
          )}
          {interactiveType === 'website_tab' && (
            <p className="text-[11px] text-white/40 mb-3">Selalu buka tab baru biasa — dipakai kalau situsnya tidak bisa dibuka dengan baik lewat popup ukuran tertentu.</p>
          )}
        </>
      )}

      {interactiveType === 'password' && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Password Description</p>
          <input
            type="text" value={furniture.interactiveConfig?.passwordDescription ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, passwordDescription: e.target.value } })}
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Password</p>
          {/* Fitur 15B — this value only ever reaches the Room Editor (this
              admin-gated GET /editor-data response) — every other client
              (ROOM_STATE/ROOM_UPDATED) gets it stripped, see
              redactFurniturePasswords server-side. */}
          <input
            type="text" value={furniture.interactiveConfig?.password ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, password: e.target.value } })}
            placeholder="Please enter the password"
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Text (muncul kalau password benar)</p>
          <textarea
            value={furniture.interactiveConfig?.correctText ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, correctText: e.target.value } })}
            rows={2}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white resize-none outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Password Failure Message</p>
          <input
            type="text" value={furniture.interactiveConfig?.failureMessage ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, failureMessage: e.target.value } })}
            placeholder="Enter incorrect answer message"
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
        </>
      )}

      {interactiveType === 'multiple_choice' && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Question</p>
          <input
            type="text" value={furniture.interactiveConfig?.question ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, question: e.target.value } })}
            className="w-full mb-2 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-purple-400"
          />
          <div className="space-y-1.5 mb-1.5">
            {(furniture.interactiveConfig?.options ?? []).map((opt, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  type="text" value={opt.text} placeholder={`Option ${i + 1}`}
                  onChange={(e) => {
                    const options = [...(furniture.interactiveConfig?.options ?? [])];
                    options[i] = { ...options[i], text: e.target.value };
                    patch({ interactiveConfig: { ...furniture.interactiveConfig, options } });
                  }}
                  className="flex-1 min-w-0 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
                />
                <label title="Correct" className="flex items-center gap-1 text-[10px] text-white/50 shrink-0 cursor-pointer">
                  <input
                    type="radio" checked={opt.isCorrect}
                    onChange={() => {
                      // Only one option is ever correct — ZEP's own radio behavior.
                      const options = (furniture.interactiveConfig?.options ?? []).map((o, j) => ({ ...o, isCorrect: j === i }));
                      patch({ interactiveConfig: { ...furniture.interactiveConfig, options } });
                    }}
                  />
                  Correct
                </label>
                {(furniture.interactiveConfig?.options?.length ?? 0) > 2 && (
                  <button
                    onClick={() => {
                      const options = (furniture.interactiveConfig?.options ?? []).filter((_, j) => j !== i);
                      patch({ interactiveConfig: { ...furniture.interactiveConfig, options } });
                    }}
                    title="Hapus opsi" className="shrink-0 w-5 h-5 rounded bg-white/10 hover:bg-white/20 text-white/50 text-xs cursor-pointer"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => {
              const options = [...(furniture.interactiveConfig?.options ?? []), { text: '', isCorrect: false }];
              patch({ interactiveConfig: { ...furniture.interactiveConfig, options } });
            }}
            className="w-full mb-3 py-1 rounded bg-white/10 hover:bg-white/20 text-white/70 text-xs cursor-pointer"
          >
            + Add option
          </button>
          <p className="text-[11px] text-white/50 mb-1.5">Text (muncul kalau jawaban benar)</p>
          <textarea
            value={furniture.interactiveConfig?.correctText ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, correctText: e.target.value } })}
            rows={2}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white resize-none outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Message After Choosing Incorrect Answer</p>
          <input
            type="text" value={furniture.interactiveConfig?.incorrectMessage ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, incorrectMessage: e.target.value } })}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-purple-400"
          />
        </>
      )}

      {interactiveType === 'api_call' && (
        <>
          <p className="text-[11px] text-white/40 mb-2">Call API. Kirim POST ke URL ini lewat server MeetKai (bukan langsung dari browser) tiap kali objek ini di-trigger.</p>
          <p className="text-[11px] text-white/50 mb-1.5">Link API</p>
          <input
            type="text" value={furniture.interactiveConfig?.apiUrl ?? ''}
            onChange={(e) => patch({ interactiveConfig: { ...furniture.interactiveConfig, apiUrl: e.target.value } })}
            placeholder="https://…"
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/40 mb-3">Harus https:// — URL lain akan ditolak saat disimpan.</p>
        </>
      )}

      {interactiveType && (
        <>
          <p className="text-[11px] text-white/50 mb-1.5">Trigger Range (tile)</p>
          <input
            type="number" min={1} max={10} value={furniture.triggerRange ?? 1}
            onChange={(e) => patch({ triggerRange: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })}
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Trigger Method</p>
          <div className="space-y-1 mb-3">
            {([['press_f', 'Press F to trigger'], ['automatic', 'Automatically trigger']] as [TriggerMethod, string][]).map(([id, label]) => (
              <label key={id} className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                <input type="radio" checked={(furniture.triggerMethod ?? 'press_f') === id} onChange={() => patch({ triggerMethod: id })} />
                {label}
              </label>
            ))}
          </div>
        </>
      )}

      <div className="h-px bg-white/10 my-3" />

      <p className="text-[11px] text-white/50 mb-1.5">Rotate & Flip</p>
      <div className="flex gap-1.5 mb-3">
        <button onClick={() => patch({ rotation: ((rotation + 90) % 360) as 0 | 90 | 180 | 270 })} title="Rotate 90°" className="flex-1 py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/70 text-xs cursor-pointer">⟳ {rotation}°</button>
        <button onClick={() => patch({ flipH: !furniture.flipH })} title="Flip horizontal" className={`flex-1 py-1.5 rounded text-xs cursor-pointer ${furniture.flipH ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>Flip H</button>
        <button onClick={() => patch({ flipV: !furniture.flipV })} title="Flip vertical" className={`flex-1 py-1.5 rounded text-xs cursor-pointer ${furniture.flipV ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>Flip V</button>
      </div>

      <label className="flex items-center gap-2 text-[11px] text-white/60 mb-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!furniture.isInteractable}
          onChange={(e) => patch(e.target.checked
            ? { isInteractable: true, sitFacing: furniture.sitFacing ?? 'front' }
            : { isInteractable: false, sitFacing: undefined })}
        />
        Sittable
      </label>
      {furniture.isInteractable && (
        <div className="flex gap-1.5 mb-3">
          {([['front', 'Depan'], ['side', 'Samping'], ['back', 'Belakang']] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => patch({ sitFacing: id })}
              className={`flex-1 py-1.5 rounded text-xs cursor-pointer ${(furniture.sitFacing ?? 'front') === id ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <p className="text-[11px] text-white/50 mb-1.5">Size(%)</p>
      <div className="flex items-center gap-2 mb-3">
        <label className="flex-1 text-[10px] text-white/40">W<input type="number" value={sizeW} onChange={(e) => patch({ sizePercent: { w: Number(e.target.value) || 100, h: sizeH } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
        <label className="flex-1 text-[10px] text-white/40">H<input type="number" value={sizeH} onChange={(e) => patch({ sizePercent: { w: sizeW, h: Number(e.target.value) || 100 } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
      </div>

      <p className="text-[11px] text-white/50 mb-1.5">Reposition(px)</p>
      <div className="flex items-center gap-2 mb-3">
        <label className="flex-1 text-[10px] text-white/40">X<input type="number" value={offX} onChange={(e) => patch({ offsetPx: { x: Number(e.target.value) || 0, y: offY } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
        <label className="flex-1 text-[10px] text-white/40">Y<input type="number" value={offY} onChange={(e) => patch({ offsetPx: { x: offX, y: Number(e.target.value) || 0 } })} className="mt-0.5 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none" /></label>
      </div>

      <button
        onClick={() => patch({ rotation: undefined, flipH: undefined, flipV: undefined, sizePercent: undefined, offsetPx: undefined })}
        className="w-full py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/70 text-xs cursor-pointer"
      >
        ↺ Reset Settings
      </button>
    </div>
  );
}

// ZEP-style door password — shown instead of the Tile Effects list while an
// existing door tile is selected (Select tool + door effect active), same
// "settings panel replaces the palette" pattern as ObjectSettingsPanel above.
function DoorSettingsPanel({
  tile, doorEffect, onBack,
}: {
  tile: { x: number; y: number };
  doorEffect: TileEffect | null;
  onBack: () => void;
}) {
  if (!doorEffect) return null;
  const patch = (p: Partial<Pick<TileEffect, 'doorPasswordEnabled' | 'doorPassword' | 'doorPasswordDescription' | 'doorFailureMessage' | 'doorTriggerMethod'>>) =>
    useEditorStore.getState().updateDoorTileEffect(tile.x, tile.y, p);
  const enabled = !!doorEffect.doorPasswordEnabled;
  const pressF = doorEffect.doorTriggerMethod === 'press_f';

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={onBack} title="Kembali ke daftar efek" className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center cursor-pointer text-white/70">←</button>
        <p className="text-xs uppercase tracking-wider text-white/40">Door Settings</p>
      </div>

      <label className="flex items-center gap-2 text-xs text-white/70 mb-3 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => patch({ doorPasswordEnabled: e.target.checked })} />
        Enable password
      </label>

      {enabled && (
        <>
          {/* Follow-up — previously always auto-fired the moment a player
              got adjacent, with no way to require an explicit press first.
              Unchecked (default) = exact old behavior. */}
          <label className="flex items-center gap-2 text-xs text-white/70 mb-3 cursor-pointer">
            <input
              type="checkbox" checked={pressF}
              onChange={(e) => patch({ doorTriggerMethod: e.target.checked ? 'press_f' : 'automatic' })}
            />
            Butuh tekan F dulu (bukan langsung muncul otomatis)
          </label>
          <p className="text-[11px] text-white/50 mb-1.5">Password Description</p>
          <input
            type="text" value={doorEffect.doorPasswordDescription ?? ''}
            onChange={(e) => patch({ doorPasswordDescription: e.target.value })}
            placeholder="Ditampilkan di prompt (opsional)"
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Password</p>
          {/* Same guarantee as the furniture password field — this value
              only ever reaches the Room Editor (admin-gated GET
              /editor-data); every other client gets it stripped
              (redactDoorPasswords, server-side). */}
          <input
            type="text" value={doorEffect.doorPassword ?? ''}
            onChange={(e) => patch({ doorPassword: e.target.value })}
            placeholder="Please enter the password"
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Pesan gagal (opsional)</p>
          <input
            type="text" value={doorEffect.doorFailureMessage ?? ''}
            onChange={(e) => patch({ doorFailureMessage: e.target.value })}
            placeholder="Password salah."
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
        </>
      )}
    </div>
  );
}

// Door Area — the free-resize (Impassable Area-style) counterpart to
// DoorSettingsPanel above. Same fields, same behavior, but bound to a
// selected AREA (updateDoorAreaEffect) instead of a stamped tile.
function DoorAreaSettingsPanel({
  areaId, doorArea, onBack,
}: {
  areaId: string;
  doorArea: AreaEffect | null;
  onBack: () => void;
}) {
  if (!doorArea) return null;
  const patch = (p: Partial<Pick<AreaEffect, 'doorPasswordEnabled' | 'doorPassword' | 'doorPasswordDescription' | 'doorFailureMessage' | 'doorTriggerMethod'>>) =>
    useEditorStore.getState().updateDoorAreaEffect(areaId, p);
  const enabled = !!doorArea.doorPasswordEnabled;
  const pressF = doorArea.doorTriggerMethod === 'press_f';

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={onBack} title="Kembali ke daftar efek" className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center cursor-pointer text-white/70">←</button>
        <p className="text-xs uppercase tracking-wider text-white/40">Door Area Settings</p>
      </div>
      <p className="text-[11px] text-white/50 mb-3">Drag badan area untuk pindah, tarik pojok/sisi untuk resize, Delete untuk hapus.</p>

      <label className="flex items-center gap-2 text-xs text-white/70 mb-3 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => patch({ doorPasswordEnabled: e.target.checked })} />
        Enable password
      </label>

      {enabled && (
        <>
          <label className="flex items-center gap-2 text-xs text-white/70 mb-3 cursor-pointer">
            <input
              type="checkbox" checked={pressF}
              onChange={(e) => patch({ doorTriggerMethod: e.target.checked ? 'press_f' : 'automatic' })}
            />
            Butuh tekan F dulu (bukan langsung muncul otomatis)
          </label>
          <p className="text-[11px] text-white/50 mb-1.5">Password Description</p>
          <input
            type="text" value={doorArea.doorPasswordDescription ?? ''}
            onChange={(e) => patch({ doorPasswordDescription: e.target.value })}
            placeholder="Ditampilkan di prompt (opsional)"
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Password</p>
          <input
            type="text" value={doorArea.doorPassword ?? ''}
            onChange={(e) => patch({ doorPassword: e.target.value })}
            placeholder="Please enter the password"
            className="w-full mb-3 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
          <p className="text-[11px] text-white/50 mb-1.5">Pesan gagal (opsional)</p>
          <input
            type="text" value={doorArea.doorFailureMessage ?? ''}
            onChange={(e) => patch({ doorFailureMessage: e.target.value })}
            placeholder="Password salah."
            className="w-full mb-1.5 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 outline-none focus:border-purple-400"
          />
        </>
      )}
    </div>
  );
}

// Sittable tile — a seat with no Furniture piece at all (see TileEffect's
// doc comment), same "settings panel for an existing stamped tile" pattern
// as DoorSettingsPanel above. Direction is picked directly (Bawah/Atas/Kiri/
// Kanan) rather than front/side/back — there's no object rotation to
// combine with on a bare tile.
function SittableSettingsPanel({
  tile, sittableEffect, onBack,
}: {
  tile: { x: number; y: number };
  sittableEffect: TileEffect | null;
  onBack: () => void;
}) {
  if (!sittableEffect) return null;
  const direction = sittableEffect.sitDirection ?? 'down';

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={onBack} title="Kembali ke daftar efek" className="w-6 h-6 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center cursor-pointer text-white/70">←</button>
        <p className="text-xs uppercase tracking-wider text-white/40">Sittable Settings</p>
      </div>

      <p className="text-[11px] text-white/50 mb-1.5">Arah hadap saat duduk</p>
      <div className="grid grid-cols-2 gap-1.5">
        {([['down', 'Bawah'], ['up', 'Atas'], ['left', 'Kiri'], ['right', 'Kanan']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => useEditorStore.getState().updateSittableTileEffect(tile.x, tile.y, id)}
            className={`py-1.5 rounded text-xs cursor-pointer ${direction === id ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Floor-plan reference guide — drawn as a translucent overlay ON TOP of
// every other layer (see the call site: floor tiles are fully opaque and
// cover every tile, so drawing this underneath would just always be hidden).
// Silently no-ops (same convention as drawSpriteFrame) if the image hasn't
// finished loading yet or has been hidden.
function drawReferenceImage(ctx: CanvasRenderingContext2D, ref: ReferenceImageData | null | undefined) {
  if (!ref || !ref.visible) return;
  const img = getSpriteImage(ref.url);
  if (!img) return;
  ctx.save();
  ctx.globalAlpha = ref.opacity;
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, ref.x, ref.y, ref.width, ref.height);
  ctx.restore();
}

// Item #9 — Impassable Area drag/resize. A handle sits on one of the
// rectangle's 4 corners or 4 edge midpoints; hit-testing works in WORLD
// (unzoomed tile-pixel) space with a tolerance converted FROM screen pixels
// (÷ zoom) so the clickable area stays a constant size on screen regardless
// of how zoomed in/out the canvas is — a fixed world-space tolerance would
// make handles nearly unclickable when zoomed out, and huge when zoomed in.
type AreaHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const AREA_HANDLE_HIT_SCREEN_PX = 10;
function areaHandlePoints(a: { x: number; y: number; width: number; height: number }): [AreaHandle, number, number][] {
  const left = a.x * TILE_SIZE, top = a.y * TILE_SIZE, right = (a.x + a.width) * TILE_SIZE, bottom = (a.y + a.height) * TILE_SIZE;
  const midX = (left + right) / 2, midY = (top + bottom) / 2;
  return [['nw', left, top], ['n', midX, top], ['ne', right, top], ['e', right, midY], ['se', right, bottom], ['s', midX, bottom], ['sw', left, bottom], ['w', left, midY]];
}
function hitTestAreaHandle(a: { x: number; y: number; width: number; height: number }, worldX: number, worldY: number, zoom: number): AreaHandle | null {
  const tol = AREA_HANDLE_HIT_SCREEN_PX / zoom;
  for (const [h, hx, hy] of areaHandlePoints(a)) if (Math.abs(worldX - hx) <= tol && Math.abs(worldY - hy) <= tol) return h;
  return null;
}
function drawAreaHandles(ctx: CanvasRenderingContext2D, a: { x: number; y: number; width: number; height: number }, zoom: number) {
  const left = a.x * TILE_SIZE, top = a.y * TILE_SIZE, right = (a.x + a.width) * TILE_SIZE, bottom = (a.y + a.height) * TILE_SIZE;
  ctx.strokeStyle = 'rgba(248,113,113,0.95)'; ctx.lineWidth = 2 / zoom; ctx.setLineDash([]);
  ctx.strokeRect(left, top, right - left, bottom - top);
  const hs = 8 / zoom;
  ctx.fillStyle = 'rgba(248,113,113,0.95)';
  for (const [, hx, hy] of areaHandlePoints(a)) ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
}

function drawLayer(ctx: CanvasRenderingContext2D, ld: LayerData, theme: RoomTheme, layer: EditorLayer) {
  if (layer === 'floor') {
    for (let y = 0; y < ld.height; y++) for (let x = 0; x < ld.width; x++)
      drawFloorTile(ctx, { x, y, type: 'floor', floorPaletteId: ld.floor[y]?.[x] ?? undefined }, x * TILE_SIZE, y * TILE_SIZE, theme);
  } else if (layer === 'wall') {
    for (let y = 0; y < ld.height; y++) for (let x = 0; x < ld.width; x++)
      if (ld.wall[y]?.[x]) drawWallTile(ctx, { x, y, type: 'wall', wallPaletteId: ld.wallPaletteId?.[y]?.[x] ?? undefined }, x * TILE_SIZE, y * TILE_SIZE, theme);
  } else if (layer === 'objects') {
    for (const item of ld.objects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'top') {
    for (const item of ld.topObjects) { drawFurnitureLayer(ctx, item, 0, 0, 'object'); drawFurnitureLayer(ctx, item, 0, 0, 'overhead'); }
  } else if (layer === 'effects') {
    // Every legacy 'desk'/'chair'/'blocked' tile round-trips into an
    // 'impassable' tileEffect (see shared/mapLayers.ts's legacyToLayerData) —
    // that conversion is load-bearing for collision (layerDataToLegacy
    // reads it back to restore the tile's blocking type), so it can't just
    // be stopped. But visually, drawing the same red "impassable" X on top
    // of a chair/desk that's ALREADY obviously blocking (it's furniture,
    // you can see it) is pure clutter — every piece of furniture in every
    // legacy-built room ends up crossed out, which reads as "something's
    // broken/cut off" rather than useful information. The X is only
    // actually informative on a tile with NO furniture drawn on it (a truly
    // invisible barrier, the effect's real intended use — see its own hint
    // text). Skip the X wherever a furniture piece's own footprint already
    // covers this tile.
    const furnitureCovered = new Set<string>();
    for (const item of [...ld.objects, ...ld.topObjects]) {
      for (let dx = 0; dx < item.tilesW; dx++) furnitureCovered.add(`${item.x + dx},${item.y}`);
    }
    for (const a of ld.areas) {
      const zx = a.x * TILE_SIZE, zy = a.y * TILE_SIZE, zw = a.width * TILE_SIZE, zh = a.height * TILE_SIZE;
      if (a.effect === 'impassable') {
        ctx.fillStyle = 'rgba(239,68,68,0.22)'; ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = 'rgba(239,68,68,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '11px sans-serif'; ctx.fillText('🚧 Impassable', zx + 4, zy + 14);
        continue;
      }
      if (a.effect === 'wallArea') {
        // Same solid-fill-plus-hazard-stripe look GameCanvas.tsx actually
        // renders during real play — the editor preview should look like
        // what players will see, not the invisible-effect styling above.
        ctx.save();
        ctx.beginPath(); ctx.rect(zx, zy, zw, zh); ctx.clip();
        ctx.fillStyle = 'rgba(55,65,81,0.92)'; ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = 'rgba(250,204,21,0.85)'; ctx.lineWidth = 4;
        for (let sx = zx - zh; sx < zx + zw; sx += 14) { ctx.beginPath(); ctx.moveTo(sx, zy + zh); ctx.lineTo(sx + zh, zy); ctx.stroke(); }
        ctx.restore();
        ctx.strokeStyle = 'rgba(17,24,39,0.9)'; ctx.lineWidth = 2; ctx.strokeRect(zx, zy, zw, zh);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText('🧱 Wall Area', zx + 4, zy + 14);
        continue;
      }
      if (a.effect === 'focusArea') {
        ctx.fillStyle = 'rgba(245,158,11,0.16)'; ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = 'rgba(245,158,11,0.95)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText(`🎧 ${a.name || 'Focus'}`, zx + 4, zy + 14);
        continue;
      }
      if (a.effect === 'meetingArea') {
        // Teal, matching presence.ts's own "In a meeting" 🎥 emoji — a
        // distinct visual "tile effect" so this reads at a glance as a
        // meeting area, not just another private area (blue) or focus area
        // (amber) while browsing the map in the editor.
        const isolated = a.audioIsolated ?? true;
        ctx.fillStyle = 'rgba(20,184,166,0.16)'; ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = 'rgba(20,184,166,0.95)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText(`🎥 ${isolated ? '🔇' : '🔊'} ${a.name || 'Meeting'}`, zx + 4, zy + 14);
        continue;
      }
      if (a.effect === 'doorArea') {
        // Tan, matching the per-tile Door effect's color — only blocks
        // movement while a password is set AND unlocked for that socket
        // (see movementHandler.ts), so it's drawn lighter than the always-
        // blocking Impassable/Wall Area above.
        ctx.fillStyle = 'rgba(212,160,86,0.16)'; ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = 'rgba(212,160,86,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText(`🚪${a.doorPasswordEnabled ? ' 🔒' : ''} ${a.name || 'Door Area'}`, zx + 4, zy + 14);
        continue;
      }
      if (a.effect === 'restrictedArea') {
        // "Ngobrol dengan CEO" queue — red, matching the 🔒 lock badge
        // GameCanvas.tsx draws on this zone's in-game banner, so the editor
        // preview reads as the same "restricted" area at a glance.
        ctx.fillStyle = 'rgba(220,38,38,0.14)'; ctx.fillRect(zx, zy, zw, zh);
        ctx.strokeStyle = 'rgba(220,38,38,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText(`🔒 ${a.name || 'Restricted'}`, zx + 4, zy + 14);
        continue;
      }
      const isPriv = a.effect === 'privateArea';
      // Private Area's outline used to match Map Location's near-opaque
      // 0.95 stroke — per the room admin it read as too loud/attention-
      // grabbing while just browsing tile effects in the editor ("jangan
      // terlalu keliatan... jadi biasa"), so it's toned down to blend in
      // more; Map Location's styling is unchanged (not what was asked).
      ctx.fillStyle = isPriv ? 'rgba(59,130,246,0.08)' : 'rgba(168,85,247,0.16)'; // blue=private, purple=map location
      ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = isPriv ? 'rgba(96,165,250,0.35)' : 'rgba(192,132,252,0.95)'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.strokeRect(zx, zy, zw, zh); ctx.setLineDash([]);
      // Same default inference as layerDataToLegacy: unset → isolates for
      // privateArea, doesn't for mapLocation — shown so the admin can see at
      // a glance which areas actually cut off audio at their boundary.
      const isolated = a.audioIsolated ?? isPriv;
      const label = isPriv ? `${a.name || 'Private'}${a.areaId ? ` #${a.areaId}` : ''}` : (a.name || 'Lokasi');
      // QA #8 — 🔒 marks a member-only Private Area (guest needs admin
      // approval to enter) so this is visible at a glance while browsing
      // the map in the editor, same "don't have to click in to know" bar
      // the isolate/capacity indicators already set.
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '11px sans-serif'; ctx.fillText(`${isolated ? '🔇' : '🔊'}${a.memberOnly ? ' 🔒' : ''} ${label}`, zx + 4, zy + 14);
    }
    for (const e of ld.tileEffects) {
      const sx = e.x * TILE_SIZE, sy = e.y * TILE_SIZE, c = TILE_SIZE / 2;
      if (e.kind === 'startingPoint') { ctx.fillStyle = 'rgba(16,185,129,0.85)'; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.fill(); }
      else if (e.kind === 'impassable' && !furnitureCovered.has(`${e.x},${e.y}`)) { ctx.strokeStyle = 'rgba(239,68,68,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx + 4, sy + 4); ctx.lineTo(sx + TILE_SIZE - 4, sy + TILE_SIZE - 4); ctx.moveTo(sx + TILE_SIZE - 4, sy + 4); ctx.lineTo(sx + 4, sy + TILE_SIZE - 4); ctx.stroke(); }
      else if (e.kind === 'portal') {
        ctx.strokeStyle = 'rgba(124,58,237,0.95)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.stroke();
        if (e.targetX != null && e.targetY != null) {
          const tx = e.targetX * TILE_SIZE + c, ty = e.targetY * TILE_SIZE + c;
          ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(sx + c, sy + c); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(124,58,237,0.45)'; ctx.beginPath(); ctx.arc(tx, ty, c - 6, 0, Math.PI * 2); ctx.fill();
        }
        const plabel = e.label || (e.targetSlug ? `→ ${e.targetSlug}` : '→ dalam room');
        ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(plabel, sx + c, sy - 2); ctx.textAlign = 'left';
      }
      else if (e.kind === 'door') { ctx.fillStyle = 'rgba(212,160,86,0.8)'; ctx.fillRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6); }
      else if (e.kind === 'sittable') {
        ctx.strokeStyle = 'rgba(56,189,248,0.85)'; ctx.lineWidth = 2; ctx.strokeRect(sx + 3, sy + 3, TILE_SIZE - 6, TILE_SIZE - 6);
        ctx.font = '16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('🪑', sx + c, sy + c + 6);
        // Small arrow toward the facing direction, so the admin can see at a
        // glance which way the avatar will sit without opening the panel.
        const dir = e.sitDirection ?? 'down';
        const ang = dir === 'down' ? Math.PI / 2 : dir === 'up' ? -Math.PI / 2 : dir === 'left' ? Math.PI : 0;
        ctx.save(); ctx.translate(sx + c, sy + c); ctx.rotate(ang);
        ctx.fillStyle = 'rgba(56,189,248,0.95)';
        ctx.beginPath(); ctx.moveTo(c - 6, 0); ctx.lineTo(c - 12, -5); ctx.lineTo(c - 12, 5); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.textAlign = 'left';
      }
      else if (e.kind === 'claimableSeat') {
        ctx.strokeStyle = 'rgba(250,204,21,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx + c, sy + c, c - 3, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('🚩', sx + c, sy + c + 6);
        ctx.textAlign = 'left';
      }
    }
  }
}

export function RoomEditorPage({ slug }: { slug: string }) {
  const [meta, setMeta] = useState<{ name: string; theme: RoomTheme } | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  // 'dirty' = edits exist that the debounce hasn't flushed yet — the admin must
  // never read "Tersimpan" while changes are only in memory (Potong 7).
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const saveStateRef = useRef(saveState); useEffect(() => { saveStateRef.current = saveState; }, [saveState]);
  // 'custom' — Fitur 15's "Uploads Kamu" tab, alongside the built-in ones.
  const [objTab, setObjTab] = useState<'furniture' | 'decor' | 'electronics' | 'custom'>('furniture');
  const [objSearch, setObjSearch] = useState('');
  // LimeZu Interiors — themed pack, lazy-loaded per category (see
  // limezuInteriors.ts). Non-empty limezuCat overrides the built-in tabs as
  // the palette's source; '' = built-in tabs active as before.
  const [limezuCat, setLimezuCat] = useState('');
  const [limezuEntries, setLimezuEntries] = useState<PaletteEntry[]>([]);
  const [limezuLoading, setLimezuLoading] = useState(false);
  useEffect(() => {
    if (!limezuCat) { setLimezuEntries([]); return; }
    let alive = true;
    setLimezuLoading(true);
    loadLimezuCategory(limezuCat).then((entries) => {
      if (!alive) return;
      setLimezuEntries(entries);
      setLimezuLoading(false);
    });
    return () => { alive = false; };
  }, [limezuCat]);
  // Transient notice (paste clipped / pasted portals keep their destination).
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }, []);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeW, setResizeW] = useState(0);
  const [resizeH, setResizeH] = useState(0);

  // Fitur 15 — Import Image: upload a custom PNG/JPG, then ask which
  // palette (Floor/Wall/Object) it belongs to. Category defaults to whatever
  // layer is active when the button is clicked (the common case), but stays
  // editable — an admin importing while on the Objects layer may still want
  // it as a Floor texture, etc.
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importCategory, setImportCategory] = useState<'floor' | 'wall' | 'object'>('object');
  const [importLabel, setImportLabel] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState('');
  const openImportPicker = async () => {
    const f = await pickFile('image/png,image/jpeg');
    if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) { window.alert('Hanya file PNG atau JPG yang diperbolehkan.'); return; }
    if (f.size > MAX_IMPORT_BYTES) { window.alert(`Ukuran file maksimal 5MB (file ini ${(f.size / 1024 / 1024).toFixed(1)}MB).`); return; }
    setImportFile(f);
    setImportLabel(f.name.replace(/\.[^.]+$/, ''));
    setImportCategory(activeLayer === 'floor' ? 'floor' : activeLayer === 'wall' ? 'wall' : 'object');
    setImportErr('');
    setImportOpen(true);
  };
  const confirmImport = async () => {
    if (!importFile) return;
    setImportBusy(true); setImportErr('');
    try {
      const { url } = await api.uploadMedia(importFile, slug);
      // tilesW/tilesH fixed at 1x1 (one 32px tile) — Fitur 15's own scope note
      // keeps this to a basic import; a multi-tile footprint picker is a
      // reasonable follow-up, not part of this pass.
      const entry: CustomAssetEntry = {
        id: `custom-${crypto.randomUUID()}`,
        label: importLabel.trim() || importFile.name,
        category: importCategory,
        src: url,
        tilesW: 1,
        tilesH: 1,
        // Server-authoritative on save (see PUT /editor/layers) — these are
        // placeholders only for the brief window before the next reload.
        createdBy: '', createdByName: 'Kamu', createdAt: Date.now(),
      };
      registerCustomAssets([entry]);
      useEditorStore.getState().addCustomAsset(entry);
      if (importCategory === 'floor') { setActiveLayer('floor'); setSelectedFloor(entry.id); }
      else if (importCategory === 'wall') { setActiveLayer('wall'); setSelectedWall(entry.id); }
      else { setActiveLayer('objects'); setObjTab('custom'); setLimezuCat(''); setSelectedObject(entry.id); }
      setImportOpen(false); setImportFile(null);
    } catch {
      setImportErr('Gagal upload gambar. Coba lagi.');
    } finally {
      setImportBusy(false);
    }
  };

  // Floor-plan reference image underlay — upload a denah photo to trace over
  // by hand (walls/floors/furniture still placed with the normal tools; this
  // is purely a visual guide, never sent to the live game). Panel toggled
  // from the toolbar; unlike Import Image's one-shot modal, this stays open
  // so opacity/position can be tweaked while looking at the traced result.
  const [refPanelOpen, setRefPanelOpen] = useState(false);
  const [refBusy, setRefBusy] = useState(false);
  const [refErr, setRefErr] = useState('');
  const referenceImage = useEditorStore((s) => s.doc?.referenceImage);

  // Room-wide avatar size — a simple room setting (not tied to any layer/
  // tool), panel toggled from the toolbar same as Reference Image.
  const [scalePanelOpen, setScalePanelOpen] = useState(false);
  const avatarScale = useEditorStore((s) => s.doc?.avatarScale) ?? 1;
  const uploadReferenceImage = async () => {
    const f = await pickFile('image/png,image/jpeg');
    if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) { window.alert('Hanya file PNG atau JPG yang diperbolehkan.'); return; }
    if (f.size > MAX_IMPORT_BYTES) { window.alert(`Ukuran file maksimal 5MB (file ini ${(f.size / 1024 / 1024).toFixed(1)}MB).`); return; }
    setRefBusy(true); setRefErr('');
    try {
      const { url } = await api.uploadMedia(f, slug);
      const doc = useEditorStore.getState().doc;
      const mapW = (doc?.width ?? MAP_WIDTH) * TILE_SIZE, mapH = (doc?.height ?? MAP_HEIGHT) * TILE_SIZE;
      // Default: cover the whole current map, half-transparent, visible —
      // an admin adjusts x/y/width/height from there to match their photo's
      // actual proportions against the grid.
      useEditorStore.getState().setReferenceImage({ url, x: 0, y: 0, width: mapW, height: mapH, opacity: 0.5, visible: true });
    } catch {
      setRefErr('Gagal upload gambar. Coba lagi.');
    } finally {
      setRefBusy(false);
    }
  };

  const [portalHint, setPortalHint] = useState(false); // awaiting internal-portal destination click
  const portalOriginRef = useRef<{ x: number; y: number } | null>(null);
  // ZEP-style door password — which existing door tile's settings panel is
  // open (Select tool + door effect, clicked on an existing door). Local
  // state (not the editor store) since it's pure UI navigation, same as
  // portalHint above — the actual password fields live in the doc via
  // updateDoorTileEffect.
  const [selectedDoorTile, setSelectedDoorTile] = useState<{ x: number; y: number } | null>(null);
  // Same pattern as selectedDoorTile above, for the Sittable Settings panel.
  const [selectedSittableTile, setSelectedSittableTile] = useState<{ x: number; y: number } | null>(null);
  // Bug 14 — a native window.confirm/prompt opened SYNCHRONOUSLY from a
  // mousedown/mouseup handler blocks the main thread, but the OS keeps
  // delivering the physical second click of a double-click gesture straight
  // to that dialog (the page's JS can't receive it while blocked) — so it
  // silently hits whatever button the dialog defaults to, often reading as
  // an instant, unintended Cancel the user never consciously saw. Deferring
  // every such dialog past the double-click window (a real click stops
  // producing further mouse events after ~a frame; a double-click's second
  // click physically lands within ~300-500ms) lets that second click finish
  // being dispatched as an ordinary click on the CANVAS — nothing is open
  // yet to steal it — before any dialog appears. The guard flag stops the
  // now-later-arriving second click from re-entering the same branch and
  // opening a SECOND dialog of its own.
  const dialogPendingRef = useRef(false);
  const DIALOG_DEFER_MS = 350;
  // Potong 6 — media effects (reuse MapMediaObject via REST). Not part of
  // layerData; fetched separately and drawn as editor markers.
  const [mediaMode, setMediaMode] = useState<'image' | 'youtube' | 'website' | 'bgm' | null>(null);
  const mediaModeRef = useRef(mediaMode); useEffect(() => { mediaModeRef.current = mediaMode; }, [mediaMode]);
  const [media, setMedia] = useState<MediaObj[]>([]);
  const mediaRef = useRef<MediaObj[]>([]);
  useEffect(() => { mediaRef.current = media; }, [media]);
  const refetchMedia = useCallback(() => { api.getRoomMedia(slug).then((r) => setMedia(r.mediaObjects as MediaObj[])).catch(() => {}); }, [slug]);

  const activeLayer = useEditorStore((s) => s.activeLayer);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const activeTool = useEditorStore((s) => s.activeTool);
  const setActiveTool = useEditorStore((s) => s.setActiveTool);
  const brushW = useEditorStore((s) => s.brushW);
  const brushH = useEditorStore((s) => s.brushH);
  const setBrushSize = useEditorStore((s) => s.setBrushSize);
  const stampMode = useEditorStore((s) => s.stampMode);
  const setStampMode = useEditorStore((s) => s.setStampMode);
  const zoomBy = useEditorStore((s) => s.zoomBy);
  const setZoom = useEditorStore((s) => s.setZoom);
  const setViewportPan = useEditorStore((s) => s.setPan);
  const zoom = useEditorStore((s) => s.viewport.zoom);
  const setDoc = useEditorStore((s) => s.setDoc);
  const selectedFloor = useEditorStore((s) => s.selectedFloorPaletteId);
  const setSelectedFloor = useEditorStore((s) => s.setSelectedFloor);
  const selectedObject = useEditorStore((s) => s.selectedObjectPaletteId);
  const setSelectedObject = useEditorStore((s) => s.setSelectedObject);
  const selectedWall = useEditorStore((s) => s.selectedWallPaletteId);
  const setSelectedWall = useEditorStore((s) => s.setSelectedWall);
  const customAssets = useEditorStore((s) => s.doc?.customAssets ?? []);
  const selectedEffect = useEditorStore((s) => s.selectedEffect);
  const setSelectedEffect = useEditorStore((s) => s.setSelectedEffect);
  const selectedAreaId = useEditorStore((s) => s.selectedAreaId);
  const selectedDoorArea = useEditorStore((s) => s.doc?.areas.find((a) => a.id === s.selectedAreaId && a.effect === 'doorArea') ?? null);
  // Item #9 — switching away from the Impassable Area tool drops the current
  // selection so its handles don't linger on screen while some other tool is
  // active (they'd be unreachable/unclickable anyway once selectedEffect
  // no longer gates the mousedown branch that hit-tests them).
  useEffect(() => { if (selectedEffect !== 'impassableArea' && selectedEffect !== 'wallArea' && selectedEffect !== 'doorArea') useEditorStore.getState().clearSelectedArea(); }, [selectedEffect]);
  const selection = useEditorStore((s) => s.selection);
  const selectedObjectId = useEditorStore((s) => s.selectedObjectId);
  const clipboard = useEditorStore((s) => s.clipboard);
  const revision = useEditorStore((s) => s.revision);
  const undoDepth = useEditorStore((s) => s.undoDepth);
  const redoDepth = useEditorStore((s) => s.redoDepth);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<{ name: string; theme: RoomTheme } | null>(null);
  const spaceHeldRef = useRef(false);
  const dragRef = useRef<{
    mode: string; last?: { x: number; y: number }; anchor?: { x: number; y: number }; fillMode?: 'stamp' | 'erase';
    // Item #9 — Impassable Area move ('areaMove') / resize ('areaResize').
    areaId?: string; handle?: AreaHandle; orig?: { x: number; y: number; w: number; h: number };
    // Which free-resize rect flavor an 'impassableAreaRect' drag creates —
    // Impassable Area (invisible) or Wall Area (visible) share the exact
    // same drag/create UX, distinguished only by this.
    effect?: 'impassable' | 'wallArea' | 'doorArea';
  } | null>(null);
  const hoverTileRef = useRef<{ x: number; y: number } | null>(null); // paste ghost anchor

  useEffect(() => { metaRef.current = meta; }, [meta]);

  useEffect(() => {
    if (!localStorage.getItem('vm_token')) { setError('auth'); return; }
    let alive = true;
    api.getRoomEditorData(slug)
      .then((r) => {
        if (!alive) return;
        const theme = ((r.theme as RoomTheme) || 'modern-interiors') as RoomTheme;
        const layer = r.layerData ?? legacyToLayerData(normalizeTiles(r.tilemapData), (r.furniture as Furniture[]) ?? [], (r.zones as Zone[]) ?? []);
        // Fitur 15 — the editor is its own browser tab (never goes through
        // useSocket's ROOM_STATE), so it must hydrate PALETTE_BY_ID here too.
        registerCustomAssets(layer.customAssets);
        setMeta({ name: r.name, theme });
        setDoc(layer);
        refetchMedia();
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof ApiError && e.status === 401 ? 'auth' : e instanceof ApiError && e.status === 403 ? 'forbidden' : e instanceof ApiError && e.status === 404 ? 'notfound' : 'generic');
      });
    return () => { alive = false; };
  }, [slug, setDoc]);

  useEffect(() => { document.title = meta ? `Editor — ${meta.name}` : 'Room Editor'; }, [meta]);

  useEffect(() => {
    if (!meta || !wrapRef.current) return;
    const doc = useEditorStore.getState().doc; if (!doc) return;
    const { clientWidth: w, clientHeight: h } = wrapRef.current;
    const mapW = doc.width * TILE_SIZE, mapH = doc.height * TILE_SIZE;
    const fit = Math.min(w / mapW, h / mapH) * 0.9;
    setZoom(fit); setViewportPan((w - mapW * fit) / 2, (h - mapH * fit) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // Debounced save. The indicator goes 'dirty' the moment an edit commits, so
  // "Tersimpan" is only ever shown when the server truly has everything.
  useEffect(() => {
    if (revision === 0) return;
    setSaveState('dirty');
    const rev = revision;
    const t = setTimeout(() => {
      const p = useEditorStore.getState().takePending();
      if (!hasChanges(p)) { if (useEditorStore.getState().revision === rev) setSaveState('saved'); return; }
      setSaveState('saving');
      api.saveRoomLayers(slug, p)
        // Only report saved if nothing new landed while this save was in
        // flight — otherwise the rerun of this effect owns the state.
        .then(() => { if (useEditorStore.getState().revision === rev) setSaveState('saved'); })
        .catch(() => { useEditorStore.getState().requeuePending(p); setSaveState('error'); });
    }, 900);
    return () => clearTimeout(t);
  }, [revision, slug]);

  useEffect(() => {
    const flush = () => { const p = useEditorStore.getState().takePending(); if (hasChanges(p)) api.saveRoomLayers(slug, p).catch(() => {}); };
    // Closing the tab with unflushed changes: ask first (the pagehide flush is
    // best-effort only — the request can be cut off mid-flight).
    const confirmClose = (e: BeforeUnloadEvent) => { if (saveStateRef.current !== 'saved') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', confirmClose);
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', confirmClose); };
  }, [slug]);

  // Continuous redraw.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current, wrap = wrapRef.current, doc = useEditorStore.getState().doc, m = metaRef.current;
      if (canvas && wrap) {
        const dpr = window.devicePixelRatio || 1, w = wrap.clientWidth, h = wrap.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#12151c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          if (doc && m) {
            const st = useEditorStore.getState();
            const { panX, panY, zoom: z } = st.viewport;
            disableImageSmoothing(ctx); ctx.setTransform(z * dpr, 0, 0, z * dpr, panX * dpr, panY * dpr);
            drawLayer(ctx, doc, m.theme, 'floor'); drawLayer(ctx, doc, m.theme, 'wall');
            drawLayer(ctx, doc, m.theme, 'objects'); drawLayer(ctx, doc, m.theme, 'top'); drawLayer(ctx, doc, m.theme, 'effects');
            // Drawn LAST (on top of floor/wall/objects), not underneath — the
            // floor layer above fills every single tile with an opaque
            // texture, so an underlay here would just always be fully
            // covered and never actually visible. A translucent overlay (its
            // own adjustable opacity is exactly what makes this work) lets
            // the admin see their in-progress trace AND the reference photo
            // at once, same as a real tracing-paper-over-a-photo workflow.
            drawReferenceImage(ctx, doc.referenceImage);
            if (z >= 0.5) {
              ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1 / z; ctx.beginPath();
              for (let x = 0; x <= doc.width; x++) { ctx.moveTo(x * TILE_SIZE, 0); ctx.lineTo(x * TILE_SIZE, doc.height * TILE_SIZE); }
              for (let y = 0; y <= doc.height; y++) { ctx.moveTo(0, y * TILE_SIZE); ctx.lineTo(doc.width * TILE_SIZE, y * TILE_SIZE); }
              ctx.stroke();
            }
            const sel = st.selection;
            if (sel) { ctx.fillStyle = 'rgba(124,58,237,0.18)'; ctx.fillRect(sel.x * TILE_SIZE, sel.y * TILE_SIZE, sel.w * TILE_SIZE, sel.h * TILE_SIZE); ctx.strokeStyle = 'rgba(167,139,250,0.95)'; ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]); ctx.strokeRect(sel.x * TILE_SIZE, sel.y * TILE_SIZE, sel.w * TILE_SIZE, sel.h * TILE_SIZE); ctx.setLineDash([]); }
            // Item #9 — drag/resize handles for the selected Impassable Area
            // (and, same free-resize UX, a selected Wall Area).
            if (st.activeLayer === 'effects' && (st.selectedEffect === 'impassableArea' || st.selectedEffect === 'wallArea' || st.selectedEffect === 'doorArea') && st.selectedAreaId) {
              const wantEffect = st.selectedEffect === 'wallArea' ? 'wallArea' : st.selectedEffect === 'doorArea' ? 'doorArea' : 'impassable';
              const selArea = doc.areas.find((a) => a.id === st.selectedAreaId && a.effect === wantEffect);
              if (selArea) drawAreaHandles(ctx, selArea, z);
            }
            // Paste ghost: the clipboard's footprint follows the cursor so the
            // admin sees exactly where the block will land (green = paste).
            const hov = hoverTileRef.current;
            if (st.activeTool === 'copy' && st.clipboard && hov) {
              const gw = st.clipboard.w * TILE_SIZE, gh = st.clipboard.h * TILE_SIZE;
              ctx.fillStyle = 'rgba(34,197,94,0.12)'; ctx.fillRect(hov.x * TILE_SIZE, hov.y * TILE_SIZE, gw, gh);
              ctx.strokeStyle = 'rgba(74,222,128,0.95)'; ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]);
              ctx.strokeRect(hov.x * TILE_SIZE, hov.y * TILE_SIZE, gw, gh); ctx.setLineDash([]);
            }
            // Selected object outline (Objects/Top layers).
            if (st.selectedObjectId && (st.activeLayer === 'objects' || st.activeLayer === 'top')) {
              const arr = st.activeLayer === 'top' ? doc.topObjects : doc.objects;
              const f = arr.find((o) => o.id === st.selectedObjectId);
              if (f) { const bx = f.x * TILE_SIZE, by = (f.y - (f.tilesH - 1)) * TILE_SIZE; ctx.strokeStyle = 'rgba(250,204,21,0.95)'; ctx.lineWidth = 2 / z; ctx.strokeRect(bx, by, f.tilesW * TILE_SIZE, f.tilesH * TILE_SIZE); }
            }
            // Media markers (Potong 6, editor-only).
            for (const mm of mediaRef.current) {
              const mx = mm.x * TILE_SIZE, my = mm.y * TILE_SIZE;
              if (mm.type === 'bgm') {
                const w = (mm.payload.areaW ?? 1) * TILE_SIZE, h = (mm.payload.areaH ?? 1) * TILE_SIZE;
                ctx.fillStyle = 'rgba(34,197,94,0.14)'; ctx.fillRect(mx, my, w, h);
                ctx.strokeStyle = 'rgba(34,197,94,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.strokeRect(mx, my, w, h); ctx.setLineDash([]);
                ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = '11px sans-serif'; ctx.fillText(`🎵 ${mm.payload.name ?? ''}`, mx + 4, my + 14);
              } else {
                const icon = mm.type === 'image' ? '🖼️' : mm.type === 'youtube' ? '▶️' : mm.type === 'website' ? '🔗' : '📌';
                ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(mx + 3, my + 3, TILE_SIZE - 6, TILE_SIZE - 6);
                ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(icon, mx + TILE_SIZE / 2, my + TILE_SIZE / 2 + 5); ctx.textAlign = 'left';
              }
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { spaceHeldRef.current = true; return; }
      const s = useEditorStore.getState();
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); s.redo(); return; }
      if (e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'q') s.setActiveTool('stamp');
      else if (k === 'w') s.setActiveTool('eraser');
      else if (k === 'v') s.setActiveTool('select');
      else if (k === 'h') s.setActiveTool('hand');
      else if (k === 'c') s.setActiveTool('copy');
      else if (e.key === 'Escape') { s.clearClipboard(); s.setSelection(null); portalOriginRef.current = null; setPortalHint(false); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if ((s.activeLayer === 'floor' || s.activeLayer === 'wall') && s.selection) { e.preventDefault(); s.fillSelection('erase'); }
        else if ((s.activeLayer === 'objects' || s.activeLayer === 'top') && s.selectedObjectId) { e.preventDefault(); s.deleteSelected(s.activeLayer === 'top' ? 'top' : 'objects'); }
        else if (s.activeLayer === 'effects' && (s.selectedEffect === 'impassableArea' || s.selectedEffect === 'wallArea' || s.selectedEffect === 'doorArea') && s.selectedAreaId) { e.preventDefault(); s.removeArea(s.selectedAreaId); }
      } else if (e.key === 'Enter' && (s.activeLayer === 'floor' || s.activeLayer === 'wall') && s.selection) { e.preventDefault(); s.fillSelection('stamp'); }
    };
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceHeldRef.current = false; };
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const tileAt = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current; if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const { panX, panY, zoom: z } = useEditorStore.getState().viewport;
    return { x: Math.floor(((clientX - r.left) - panX) / (z * TILE_SIZE)), y: Math.floor(((clientY - r.top) - panY) / (z * TILE_SIZE)) };
  }, []);

  // Item #9 — same conversion as tileAt, but WITHOUT flooring to a tile index
  // — needed to hit-test the small resize handles at sub-tile precision (see
  // hitTestAreaHandle above). Returns world (unzoomed tile-pixel) coordinates.
  const worldPointAt = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current; if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const { panX, panY, zoom: z } = useEditorStore.getState().viewport;
    return { x: ((clientX - r.left) - panX) / z, y: ((clientY - r.top) - panY) / z };
  }, []);

  // Brush size (Toolbar's Brush control) — applies the given per-tile action
  // to every tile in a brushW×brushH area centered on (cx, cy), clamped to
  // the map's bounds. Only used in stampMode 'click'. Shared by Floor/Wall
  // paint+erase and the position-only Tile Effects; Objects/Portal/
  // mapLocation-privateArea don't use this (see editorStore.ts's brushW/H
  // doc comment for why).
  const forEachBrushTile = useCallback((cx: number, cy: number, fn: (x: number, y: number) => void) => {
    const s = useEditorStore.getState();
    const doc = s.doc; if (!doc) return;
    const rw = Math.floor((s.brushW - 1) / 2);
    const rh = Math.floor((s.brushH - 1) / 2);
    for (let dy = 0; dy < s.brushH; dy++) {
      for (let dx = 0; dx < s.brushW; dx++) {
        const x = cx - rw + dx, y = cy - rh + dy;
        if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) continue;
        fn(x, y);
      }
    }
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const s = useEditorStore.getState();
    if (s.activeTool === 'hand' || spaceHeldRef.current) { dragRef.current = { mode: 'pan', last: { x: e.clientX, y: e.clientY } }; return; }
    const t = tileAt(e.clientX, e.clientY);
    // Copy tool (Potong 7) works across ALL layers: no clipboard yet → drag a
    // marquee to capture; clipboard armed → every click stamps a paste.
    if (s.activeTool === 'copy') {
      if (s.clipboard) {
        const r = s.pasteAt(t.x, t.y);
        if (r) {
          const msgs: string[] = [];
          if (r.clipped) msgs.push('Bagian di luar batas map tidak ditempel.');
          if (r.portals > 0) msgs.push(`${r.portals} portal tersalin menunjuk tujuan yang SAMA dengan aslinya.`);
          if (msgs.length) showNotice(msgs.join(' '));
        }
      } else {
        s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 });
        dragRef.current = { mode: 'copyRect', anchor: { x: t.x, y: t.y } };
      }
      return;
    }
    const layer = s.activeLayer;
    if (layer === 'floor' || layer === 'wall') {
      if (s.stampMode === 'block' && (s.activeTool === 'stamp' || s.activeTool === 'eraser')) {
        s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 });
        dragRef.current = { mode: 'blockRect', anchor: { x: t.x, y: t.y }, fillMode: s.activeTool === 'stamp' ? 'stamp' : 'erase' };
      }
      else if (s.activeTool === 'stamp') { s.beginStroke(); forEachBrushTile(t.x, t.y, layer === 'floor' ? s.paintFloorAt : s.stampWallAt); dragRef.current = { mode: layer === 'floor' ? 'floorPaint' : 'wallPaint' }; }
      else if (s.activeTool === 'eraser') { s.beginStroke(); forEachBrushTile(t.x, t.y, layer === 'floor' ? s.eraseFloorAt : s.eraseWallAt); dragRef.current = { mode: layer === 'floor' ? 'floorErase' : 'wallErase' }; }
      else if (s.activeTool === 'select') { s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 }); dragRef.current = { mode: 'selectRect', anchor: { x: t.x, y: t.y } }; }
    } else if (layer === 'objects' || layer === 'top') {
      const ol = layer === 'top' ? 'top' : 'objects';
      if (s.activeTool === 'stamp') {
        const entry = s.selectedObjectPaletteId ? PALETTE_BY_ID[s.selectedObjectPaletteId] : null;
        if (entry) s.placeObject({ id: crypto.randomUUID(), paletteId: entry.id, x: t.x, y: t.y, tilesW: entry.tilesW || 1, tilesH: entry.tilesH || 1, isInteractable: !!entry.sittable }, ol);
      } else if (s.activeTool === 'eraser') { const o = s.objectAt(t.x, t.y, ol); if (o) s.removeObject(o.id, ol); }
      else if (s.activeTool === 'select') { s.selectObjectAt(t.x, t.y, ol); if (useEditorStore.getState().selectedObjectId) { s.beginStroke(); dragRef.current = { mode: 'objMove' }; } }
    } else if (layer === 'effects') {
      // Media effects (MapMediaObject) take precedence when a media mode is armed.
      if (mediaModeRef.current) {
        if (s.activeTool === 'stamp') void placeMedia(mediaModeRef.current, t.x, t.y);
        else if (s.activeTool === 'eraser') { const m = mediaAt(t.x, t.y); if (m) api.deleteRoomMedia(slug, m.id).then(refetchMedia).catch(() => {}); }
        return;
      }
      const eff = s.selectedEffect; if (!eff) return;
      const isPointEffect = eff === 'startingPoint' || eff === 'impassable' || eff === 'door' || eff === 'sittable' || eff === 'claimableSeat';
      if (isPointEffect && s.stampMode === 'block' && (s.activeTool === 'stamp' || s.activeTool === 'eraser')) {
        s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 });
        dragRef.current = { mode: 'blockRect', anchor: { x: t.x, y: t.y }, fillMode: s.activeTool === 'stamp' ? 'stamp' : 'erase' };
        return;
      }
      if (eff === 'startingPoint' || eff === 'impassable') {
        if (s.activeTool === 'stamp') { s.beginStroke(); forEachBrushTile(t.x, t.y, s.stampEffectAt); dragRef.current = { mode: 'effPaint' }; }
        else if (s.activeTool === 'eraser') { s.beginStroke(); forEachBrushTile(t.x, t.y, s.eraseEffectAt); dragRef.current = { mode: 'effErase' }; }
      } else if (eff === 'door') {
        if (s.activeTool === 'stamp') { s.beginStroke(); forEachBrushTile(t.x, t.y, s.stampEffectAt); dragRef.current = { mode: 'effPaint' }; }
        else if (s.activeTool === 'eraser') {
          s.beginStroke(); forEachBrushTile(t.x, t.y, s.eraseEffectAt); dragRef.current = { mode: 'effErase' };
          setSelectedDoorTile((prev) => (prev && prev.x === t.x && prev.y === t.y) ? null : prev);
        } else if (s.activeTool === 'select') {
          setSelectedDoorTile(s.doorEffectAt(t.x, t.y) ? { x: t.x, y: t.y } : null);
        }
      } else if (eff === 'sittable') {
        if (s.activeTool === 'stamp') { s.beginStroke(); forEachBrushTile(t.x, t.y, s.stampEffectAt); dragRef.current = { mode: 'effPaint' }; }
        else if (s.activeTool === 'eraser') {
          s.beginStroke(); forEachBrushTile(t.x, t.y, s.eraseEffectAt); dragRef.current = { mode: 'effErase' };
          setSelectedSittableTile((prev) => (prev && prev.x === t.x && prev.y === t.y) ? null : prev);
        } else if (s.activeTool === 'select') {
          setSelectedSittableTile(s.sittableEffectAt(t.x, t.y) ? { x: t.x, y: t.y } : null);
        }
      } else if (eff === 'claimableSeat') {
        // No per-marker settings panel (position is the only data) — just
        // stamp/erase, same as startingPoint/impassable above. Brushed, a
        // stamp places one distinct marker per covered tile (stampEffectAt
        // mints a fresh id every call) — intentional for "mark a whole row
        // of seats at once", not a bug.
        if (s.activeTool === 'stamp') { s.beginStroke(); forEachBrushTile(t.x, t.y, s.stampEffectAt); dragRef.current = { mode: 'effPaint' }; }
        else if (s.activeTool === 'eraser') { s.beginStroke(); forEachBrushTile(t.x, t.y, s.eraseEffectAt); dragRef.current = { mode: 'effErase' }; }
      } else if (eff === 'portal') {
        if (s.activeTool === 'eraser') { s.eraseEffectAt(t.x, t.y); return; }
        if (s.activeTool !== 'stamp') return;
        if (dialogPendingRef.current) return; // Bug 14 — a dialog from this same click-gesture is already about to open
        // Second click of an internal portal = pick the destination tile.
        if (portalOriginRef.current) {
          const origin = portalOriginRef.current; portalOriginRef.current = null; setPortalHint(false);
          dialogPendingRef.current = true;
          setTimeout(() => {
            const label = (window.prompt('Nama portal (opsional):', '') ?? '').trim();
            dialogPendingRef.current = false;
            s.addPortal(origin.x, origin.y, { targetX: t.x, targetY: t.y, label: label || undefined });
          }, DIALOG_DEFER_MS);
          return;
        }
        // First click: choose cross-room vs internal.
        dialogPendingRef.current = true;
        setTimeout(() => {
          const wantsCrossRoom = window.confirm('Portal ke ROOM LAIN?\n\nOK = pilih room lain · Batal = titik dalam room ini');
          if (wantsCrossRoom) {
            const target = (window.prompt('Kode room tujuan (slug dari URL/share):', '') ?? '').trim();
            dialogPendingRef.current = false;
            if (!target) return;
            const label = (window.prompt('Nama portal (opsional):', '') ?? '').trim();
            s.addPortal(t.x, t.y, { targetSlug: target, label: label || undefined });
          } else {
            dialogPendingRef.current = false;
            portalOriginRef.current = { x: t.x, y: t.y }; setPortalHint(true);
          }
        }, DIALOG_DEFER_MS);
      } else if (eff === 'impassableArea' || eff === 'wallArea' || eff === 'doorArea') {
        // Item #9 (free-resize follow-up) — select/move/resize/create, in
        // that priority order (a handle on the currently-selected area
        // always wins over starting a new rectangle or re-selecting
        // something else underneath it). Uses raw fractional tile position
        // (worldPointAt ÷ TILE_SIZE, NOT tileAt()'s floored integer) for
        // every hit-test/anchor here — unlike every other rectangle tool on
        // this page, an Impassable Area's position/size is intentionally
        // NOT grid-snapped, so a click near a fractional edge must be
        // tested against that same fractional boundary or it'll miss.
        //
        // Wall Area (Recommended-flow follow-up) reuses this EXACT same
        // select/move/resize/create UX — only the stored `effect` and its
        // rendering differ (see mapLayers.ts / GameCanvas.tsx) — rather than
        // duplicating ~40 lines of near-identical drag handling.
        const targetEffect: 'impassable' | 'wallArea' | 'doorArea' = eff === 'wallArea' ? 'wallArea' : eff === 'doorArea' ? 'doorArea' : 'impassable';
        const wp0 = worldPointAt(e.clientX, e.clientY);
        const fx = wp0.x / TILE_SIZE, fy = wp0.y / TILE_SIZE;
        if (s.activeTool === 'eraser') { s.removeAreaAt(fx, fy, targetEffect); return; }
        const selected = s.selectedAreaId ? (s.doc?.areas.find((a) => a.id === s.selectedAreaId && a.effect === targetEffect) ?? null) : null;
        if (selected) {
          const handle = hitTestAreaHandle(selected, wp0.x, wp0.y, s.viewport.zoom);
          if (handle) {
            s.beginStroke();
            dragRef.current = { mode: 'areaResize', areaId: selected.id, handle, orig: { x: selected.x, y: selected.y, w: selected.width, h: selected.height } };
            return;
          }
          if (fx >= selected.x && fx < selected.x + selected.width && fy >= selected.y && fy < selected.y + selected.height) {
            s.beginStroke();
            dragRef.current = { mode: 'areaMove', areaId: selected.id, anchor: { x: fx, y: fy } };
            return;
          }
        }
        const hit = s.areaAt(fx, fy, targetEffect);
        if (hit) {
          s.selectAreaAt(fx, fy, targetEffect);
          s.beginStroke();
          dragRef.current = { mode: 'areaMove', areaId: hit.id, anchor: { x: fx, y: fy } };
          return;
        }
        s.clearSelectedArea();
        s.setSelection({ x: fx, y: fy, w: 0, h: 0 });
        dragRef.current = { mode: 'impassableAreaRect', anchor: { x: fx, y: fy }, effect: targetEffect };
      } else { // mapLocation | privateArea | focusArea | meetingArea | restrictedArea — rectangular
        if (s.activeTool === 'eraser') { s.removeAreaAt(t.x, t.y, eff as 'mapLocation' | 'privateArea' | 'focusArea' | 'meetingArea' | 'restrictedArea'); }
        else { s.setSelection({ x: t.x, y: t.y, w: 1, h: 1 }); dragRef.current = { mode: 'areaRect', anchor: { x: t.x, y: t.y } }; }
      }
    }
  }, [tileAt, worldPointAt, forEachBrushTile]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    hoverTileRef.current = tileAt(e.clientX, e.clientY); // paste-ghost anchor
    const d = dragRef.current; if (!d) return;
    const s = useEditorStore.getState();
    if (d.mode === 'pan' && d.last) { s.panBy(e.clientX - d.last.x, e.clientY - d.last.y); d.last = { x: e.clientX, y: e.clientY }; return; }
    const t = tileAt(e.clientX, e.clientY);
    if (d.mode === 'floorPaint') forEachBrushTile(t.x, t.y, s.paintFloorAt);
    else if (d.mode === 'floorErase') forEachBrushTile(t.x, t.y, s.eraseFloorAt);
    else if (d.mode === 'wallPaint') forEachBrushTile(t.x, t.y, s.stampWallAt);
    else if (d.mode === 'wallErase') forEachBrushTile(t.x, t.y, s.eraseWallAt);
    else if (d.mode === 'objMove') s.moveSelectedTo(t.x, t.y, s.activeLayer === 'top' ? 'top' : 'objects');
    else if (d.mode === 'effPaint') forEachBrushTile(t.x, t.y, s.stampEffectAt);
    else if (d.mode === 'effErase') forEachBrushTile(t.x, t.y, s.eraseEffectAt);
    else if (d.mode === 'areaMove' && d.areaId && d.anchor) {
      // Free-resize follow-up — fractional tile position (not tileAt's
      // floored integer), so the drag tracks the cursor smoothly instead of
      // hopping a whole tile at a time.
      const wp = worldPointAt(e.clientX, e.clientY);
      const fx = wp.x / TILE_SIZE, fy = wp.y / TILE_SIZE;
      const dx = fx - d.anchor.x, dy = fy - d.anchor.y;
      if (dx !== 0 || dy !== 0) { s.moveAreaBy(d.areaId, dx, dy); d.anchor = { x: fx, y: fy }; }
    }
    else if (d.mode === 'areaResize' && d.areaId && d.handle && d.orig) {
      const wp = worldPointAt(e.clientX, e.clientY);
      // Free-resize follow-up — the raw fractional tile position, unrounded.
      // Every OTHER rectangle on this page snaps to whole tiles; Impassable
      // Area deliberately doesn't (collision still ends up whole-tile at
      // save time regardless — see layerDataToLegacy's floor/ceil pass —
      // this only affects how smoothly it drags in the editor).
      const rx = wp.x / TILE_SIZE, ry = wp.y / TILE_SIZE;
      let { x, y, w, h } = d.orig;
      const x2 = x + w, y2 = y + h;
      const MIN_SIZE = 0.2; // tiles — keeps a resize from collapsing to zero/negative
      if (d.handle.includes('w')) { x = Math.min(rx, x2 - MIN_SIZE); w = x2 - x; }
      if (d.handle.includes('e')) { const nx2 = Math.max(rx, x + MIN_SIZE); w = nx2 - x; }
      if (d.handle.includes('n')) { y = Math.min(ry, y2 - MIN_SIZE); h = y2 - y; }
      if (d.handle.includes('s')) { const ny2 = Math.max(ry, y + MIN_SIZE); h = ny2 - y; }
      s.resizeArea(d.areaId, { x: Math.max(0, x), y: Math.max(0, y), w, h });
    }
    else if (d.mode === 'impassableAreaRect' && d.anchor) {
      // Free-resize follow-up — fractional, not tile-snapped (see areaResize
      // above for why). No "+1" tile-inclusive term either — that only made
      // sense for integer tile counting.
      const wp = worldPointAt(e.clientX, e.clientY);
      const fx = wp.x / TILE_SIZE, fy = wp.y / TILE_SIZE;
      s.setSelection({ x: Math.min(d.anchor.x, fx), y: Math.min(d.anchor.y, fy), w: Math.abs(fx - d.anchor.x), h: Math.abs(fy - d.anchor.y) });
    }
    else if ((d.mode === 'selectRect' || d.mode === 'areaRect' || d.mode === 'copyRect' || d.mode === 'blockRect') && d.anchor) s.setSelection({ x: Math.min(d.anchor.x, t.x), y: Math.min(d.anchor.y, t.y), w: Math.abs(t.x - d.anchor.x) + 1, h: Math.abs(t.y - d.anchor.y) + 1 });
  }, [tileAt, worldPointAt, forEachBrushTile]);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (d && ['floorPaint', 'floorErase', 'wallPaint', 'wallErase', 'objMove', 'effPaint', 'effErase', 'areaMove', 'areaResize'].includes(d.mode)) useEditorStore.getState().endStroke();
    if (d && d.mode === 'copyRect') {
      const s = useEditorStore.getState();
      if (s.selection) s.copyRegion(s.selection);
      s.setSelection(null);
    }
    if (d && d.mode === 'blockRect') {
      // "Blok" mode (Toolbar toggle) — the whole dragged rectangle gets the
      // current stamp/eraser applied in one shot on release, reusing
      // fillSelection (same action the Select tool's Enter/Delete shortcut
      // already used for floor/wall, now extended to cover the effects
      // layer too — see editorStore.ts).
      const s = useEditorStore.getState();
      if (s.selection && d.fillMode) s.fillSelection(d.fillMode);
      s.setSelection(null);
    }
    if (d && d.mode === 'areaRect') {
      const s = useEditorStore.getState();
      const sel = s.selection; s.setSelection(null);
      // Bug 14 — same double-click-dismisses-the-dialog issue as the portal
      // flow above: a quick click-release here (a 1x1 selection) fires this
      // prompt on mouseup, and a double-click's second physical click can
      // land on/dismiss it before the user ever consciously sees it. Deferred
      // + guarded the same way.
      if (sel && !dialogPendingRef.current) {
        dialogPendingRef.current = true;
        setTimeout(() => {
          if (s.selectedEffect === 'privateArea') {
            const name = (window.prompt('Nama private area:', 'Private') ?? '').trim();
            const areaId = (window.prompt('Area ID (samakan untuk menggabung area terpisah jadi satu grup):', '1') ?? '').trim();
            // Default OK = kedap suara — that's the entire point of a private
            // area — but still adjustable per-area for the rare case of "one
            // grouped audio room split across a boundary that shouldn't also
            // go silent against its own neighbors".
            const isolate = window.confirm('Area ini KEDAP SUARA?\n\nOK = ya — orang di luar area ini tidak akan saling dengar dengan yang di dalam (perilaku normal Private Area).\nBatal = tidak — cuma jarak biasa yang menentukan siapa dengar siapa.');
            const capacityRaw = (window.prompt('Kapasitas maksimal orang di area ini (kosongkan = tanpa batas):', '') ?? '').trim();
            const capacityNum = capacityRaw ? parseInt(capacityRaw, 10) : NaN;
            const capacity = Number.isInteger(capacityNum) && capacityNum > 0 ? capacityNum : undefined;
            // QA #8 — "ODOO/AI TEAM hanya anggota; terkunci bagi guest." Default
            // Batal = tidak member-only, matching every other toggle here
            // ("no new restriction" is always the safe default for an area
            // authored before this existed, or for an admin who just wants a
            // private room with no guest-gating at all).
            const memberOnly = window.confirm('Area ini KHUSUS ANGGOTA (tidak untuk guest)?\n\nOK = ya — guest yang coba masuk butuh persetujuan admin dulu.\nBatal = tidak — guest bebas masuk seperti member biasa.');
            s.addArea('privateArea', sel, name || 'Private', areaId || undefined, isolate, capacity, memberOnly);
          } else if (s.selectedEffect === 'mapLocation') {
            const name = (window.prompt('Nama lokasi:', '') ?? '').trim();
            // Default Batal = TIDAK kedap suara — Map Location is just a named
            // pin (e.g. "Team C", "Dev Team"), not a meeting room; before this
            // toggle existed every map location accidentally silenced anyone
            // standing just outside its boundary like a real private room.
            const isolate = window.confirm('Area ini KEDAP SUARA?\n\nOK = ya — isolasi audio seperti Private Area.\nBatal (disarankan) = tidak — Map Location cuma label nama, jarak biasa yang menentukan siapa dengar siapa.');
            s.addArea('mapLocation', sel, name || 'Lokasi', undefined, isolate);
          } else if (s.selectedEffect === 'focusArea') {
            const name = (window.prompt('Nama focus area:', 'Focus') ?? '').trim();
            s.addArea('focusArea', sel, name || 'Focus');
          } else if (s.selectedEffect === 'meetingArea') {
            const name = (window.prompt('Nama meeting area:', 'Meeting') ?? '').trim();
            // Default OK = kedap suara, same reasoning as Private Area — a
            // meeting in progress shouldn't bleed into/from whatever's
            // happening just outside its walls.
            const isolate = window.confirm('Area ini KEDAP SUARA?\n\nOK = ya — orang di luar area ini tidak akan saling dengar dengan yang di dalam.\nBatal = tidak — cuma jarak biasa yang menentukan siapa dengar siapa.');
            s.addArea('meetingArea', sel, name || 'Meeting', undefined, isolate);
          } else if (s.selectedEffect === 'restrictedArea') {
            const name = (window.prompt('Nama area (mis. "CEO Office"):', 'CEO Office') ?? '').trim();
            const id = s.addArea('restrictedArea', sel, name || 'Restricted Area');
            // "Ngobrol dengan CEO" queue (see server/src/lib/zoneMembership.ts)
            // — always admin-only with the self-service queue on, matching
            // "admin aja + langsung isi form" exactly; no extra prompts here
            // (unlike Private Area above) since there's nothing else useful
            // to ask at creation time. The restriction itself lives in a
            // separate table (ZoneRestriction), not on this area/zone object,
            // so it needs its own request right after the area is created.
            adminApi.setZoneRestriction(slug, id, { enabled: true, minRole: 'admin', queueEnabled: true }).catch((err) => {
              console.error('[room-editor] failed to mark area restricted:', err);
              window.alert('Area berhasil dibuat, tapi gagal menandainya sebagai restricted. Hapus area ini (Eraser) lalu gambar ulang untuk coba lagi.');
            });
          }
          dialogPendingRef.current = false;
        }, DIALOG_DEFER_MS);
      }
    }
    if (d && d.mode === 'impassableAreaRect') {
      // Item #9 — unlike areaRect above, no naming dialog: neither an
      // Impassable Area nor a Wall Area has anything to name (both excluded
      // from the zones list entirely, see mapLayers.ts). Auto-selected right
      // after creation so its resize handles are visible immediately,
      // matching "buat lalu langsung bisa di-adjust" rather than requiring a
      // second click to select it.
      const s = useEditorStore.getState();
      const sel = s.selection; s.setSelection(null);
      const targetEffect = d.effect ?? 'impassable';
      // A plain click without dragging now yields a 0×0 selection (no "+1
      // tile" floor like the grid-snapped rectangles get) — skip creating a
      // degenerate, invisible area instead of silently adding a zero-size one.
      if (sel && sel.w > 0.05 && sel.h > 0.05) {
        s.addArea(targetEffect, sel, targetEffect === 'wallArea' ? 'Wall Area' : targetEffect === 'doorArea' ? 'Pintu' : 'Impassable Area');
        s.selectAreaAt(sel.x, sel.y, targetEffect);
      }
    }
    dragRef.current = null;
  }, []);

  const openResize = () => { const d = useEditorStore.getState().doc; if (d) { setResizeW(d.width); setResizeH(d.height); } setResizeOpen(true); };
  const applyResize = () => {
    const d = useEditorStore.getState().doc; if (!d) return;
    const w = Math.max(1, Math.min(200, Math.floor(resizeW))), h = Math.max(1, Math.min(200, Math.floor(resizeH)));
    if (w === d.width && h === d.height) { setResizeOpen(false); return; }
    const oob = (o: { x: number; y: number }) => o.x >= w || o.y >= h;
    const outObj = d.objects.filter(oob).length + d.topObjects.filter(oob).length;
    let outWall = 0;
    for (let y = 0; y < d.wall.length; y++) for (let x = 0; x < (d.wall[y]?.length ?? 0); x++) if ((x >= w || y >= h) && d.wall[y][x]) outWall++;
    const outEff = d.tileEffects.filter(oob).length;
    const outAreas = d.areas.filter((a) => a.x + a.width > w || a.y + a.height > h).length;
    // Block: can't remove every starting point.
    const sp = d.tileEffects.filter((e) => e.kind === 'startingPoint');
    if (sp.length > 0 && sp.every((e) => e.x >= w || e.y >= h)) {
      window.alert('Resize diblokir: semua starting point akan terpotong. Pindahkan minimal satu ke dalam batas baru dulu.');
      return;
    }
    // Block: an internal portal's destination would be cut.
    if (d.tileEffects.some((e) => e.kind === 'portal' && e.targetX != null && e.targetY != null && (e.targetX >= w || e.targetY >= h))) {
      window.alert('Resize diblokir: ada tujuan portal internal yang akan terpotong. Pindahkan/hapus portal itu dulu.');
      return;
    }
    const shrinking = w < d.width || h < d.height;
    const losses = outObj + outWall + outEff + outAreas;
    if (shrinking && losses > 0 && !window.confirm(`Mengecilkan map akan MENGHAPUS konten di luar batas baru:\n\n• ${outObj} objek\n• ${outWall} tile wall\n• ${outEff} tile efek\n• ${outAreas} area\n\nLanjutkan?`)) return;
    useEditorStore.getState().resizeMap(w, h);
    setResizeOpen(false);
  };

  const mediaAt = (x: number, y: number): MediaObj | null => {
    for (let i = mediaRef.current.length - 1; i >= 0; i--) {
      const m = mediaRef.current[i];
      const w = m.type === 'bgm' ? (m.payload.areaW ?? 1) : 1, h = m.type === 'bgm' ? (m.payload.areaH ?? 1) : 1;
      if (x >= m.x && x < m.x + w && y >= m.y && y < m.y + h) return m;
    }
    return null;
  };
  const placeMedia = async (kind: 'image' | 'youtube' | 'website' | 'bgm', x: number, y: number) => {
    try {
      if (kind === 'image') {
        const f = await pickFile('image/*'); if (!f) return;
        if (f.size > 10 * 1024 * 1024) { window.alert('Gambar maksimal 10MB.'); return; }
        const { url } = await api.uploadMedia(f, slug);
        await api.addRoomMedia(slug, { type: 'image', x, y, payload: { url } });
      } else if (kind === 'youtube') {
        const raw = (window.prompt('URL YouTube:', '') ?? '').trim(); if (!raw) return;
        const id = parseYouTubeId(raw); if (!id) { window.alert('URL YouTube tidak valid.'); return; }
        await api.addRoomMedia(slug, { type: 'youtube', x, y, payload: { videoId: id } });
      } else if (kind === 'website') {
        const u = (window.prompt('URL website (harus https://):', 'https://') ?? '').trim();
        if (!/^https:\/\/\S+/i.test(u)) { window.alert('Hanya URL https:// yang diperbolehkan.'); return; }
        await api.addRoomMedia(slug, { type: 'website', x, y, payload: { websiteUrl: u } });
      } else {
        const f = await pickFile('audio/mpeg,audio/ogg,audio/*'); if (!f) return;
        if (f.size > 10 * 1024 * 1024) { window.alert('Audio maksimal 10MB.'); return; }
        const name = (window.prompt('Nama area musik:', 'Musik') ?? 'Musik').trim();
        const w = Math.max(1, parseInt(window.prompt('Lebar area (tile):', '4') || '4', 10) || 4);
        const h = Math.max(1, parseInt(window.prompt('Tinggi area (tile):', '4') || '4', 10) || 4);
        const { url } = await api.uploadMedia(f, slug);
        await api.addRoomMedia(slug, { type: 'bgm', x, y, payload: { audioUrl: url, areaW: w, areaH: h, name, volume: 0.3 } });
      }
      refetchMedia();
    } catch { window.alert('Gagal menambah media.'); }
  };

  const floorEntries = meta ? PALETTE_BY_THEME[meta.theme].filter((p) => p.category === 'floor') : [];
  // Fitur 15 — this room's uploads, split by which palette they belong to.
  const customFloorEntries = customAssets.filter((a) => a.category === 'floor');
  const customWallEntries = customAssets.filter((a) => a.category === 'wall');
  const customObjectEntries = customAssets.filter((a) => a.category === 'object');
  // Searching looks across ALL object categories (ignoring the active tab) —
  // the admin types a name because they don't know which tab it lives in.
  // With a LimeZu theme active, search filters within that theme's (already
  // loaded) entries instead — cross-searching all 21 unloaded LimeZu
  // manifests at once would mean fetching the whole ~5.400-entry pack, the
  // exact cost lazy loading exists to avoid.
  const objQuery = objSearch.trim().toLowerCase();
  const objEntries = limezuCat
    ? limezuEntries.filter((p) => !objQuery || p.label.toLowerCase().includes(objQuery))
    : objTab === 'custom'
      // Fitur 15 — already-registered in PALETTE_BY_ID by registerCustomAssets;
      // reuse it as the render source, same as every other tab here.
      ? customObjectEntries.map((a) => PALETTE_BY_ID[a.id]).filter((p): p is PaletteEntry => !!p && (!objQuery || p.label.toLowerCase().includes(objQuery)))
      : meta
        ? PALETTE_BY_THEME[meta.theme].filter((p) => objQuery ? p.category !== 'floor' && p.label.toLowerCase().includes(objQuery) : p.category === objTab)
        : [];
  const canPaint = activeTool === 'stamp' || activeTool === 'eraser';
  const cursor = (activeTool === 'hand' || spaceHeldRef.current) ? 'grab' : canPaint ? 'crosshair' : activeTool === 'select' ? 'cell' : activeTool === 'copy' ? (clipboard ? 'copy' : 'cell') : 'default';
  // Brush size only makes sense for Floor/Wall and the position-only Tile
  // Effects — not Objects (their size is the palette entry's own tilesW/H),
  // Portal (two-click dialog), or mapLocation/privateArea (rectangle drag).
  const brushApplicable = activeLayer === 'floor' || activeLayer === 'wall'
    || (activeLayer === 'effects' && !mediaMode && !!selectedEffect && selectedEffect !== 'portal' && selectedEffect !== 'mapLocation' && selectedEffect !== 'privateArea' && selectedEffect !== 'impassableArea' && selectedEffect !== 'restrictedArea' && selectedEffect !== 'doorArea');

  if (error) {
    const msg = error === 'auth' ? 'Kamu harus login dulu untuk membuka editor.' : error === 'forbidden' ? 'Akses ditolak — hanya admin room ini yang boleh membuka editor.' : error === 'notfound' ? 'Room tidak ditemukan.' : 'Gagal memuat editor.';
    return <div className="fixed inset-0 flex items-center justify-center bg-gray-900 text-center px-6"><div><p className="text-white text-lg font-semibold mb-1">Room Editor</p><p className="text-white/60 text-sm">{msg}</p></div></div>;
  }

  const isObjLayer = activeLayer === 'objects' || activeLayer === 'top';
  // Fitur 15B — read straight off the live doc (not a memoized selector):
  // this component already re-renders on every edit (subscribed to
  // `revision`) and on selection changes (subscribed to `selectedObjectId`
  // above), so this is always fresh by the time it's read.
  const selectedFurnitureLayer: 'objects' | 'top' = activeLayer === 'top' ? 'top' : 'objects';
  const selectedFurniture = isObjLayer && selectedObjectId
    ? (useEditorStore.getState().doc?.[selectedFurnitureLayer === 'top' ? 'topObjects' : 'objects'] ?? []).find((f) => f.id === selectedObjectId) ?? null
    : null;

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-900 text-gray-100 select-none">
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 border-b border-white/10 bg-gray-950/60">
        <span className="text-sm font-semibold text-white/90 truncate max-w-[160px]">{meta ? meta.name : 'Memuat…'}</span>
        <div className="flex items-center gap-1">
          {EDITOR_LAYERS.map((l) => (
            <button key={l.id} onClick={() => setActiveLayer(l.id)} title={l.label}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${activeLayer === l.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>{l.label}</button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/10" />
        <div className="flex items-center gap-1">
          {EDITOR_TOOLS.map((t) => (
            <button key={t.id} onClick={() => setActiveTool(t.id)} title={`${t.label} (${t.key})`}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${activeTool === t.id ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>{t.label}</button>
          ))}
        </div>
        {brushApplicable && (
          <>
            <div className="w-px h-6 bg-white/10" />
            <div className="flex items-center gap-1" title="Klik: kuas per klik/drag · Blok: drag area lalu lepas untuk menerapkan sekaligus">
              {(['click', 'block'] as const).map((m) => (
                <button key={m} onClick={() => setStampMode(m)}
                  className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${stampMode === m ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>
                  {m === 'click' ? 'Klik' : 'Blok'}
                </button>
              ))}
            </div>
            {stampMode === 'click' ? (
              <>
                <div className="w-px h-6 bg-white/10" />
                <div className="flex items-center gap-1" title="Ukuran kuas (kotak) — berlaku untuk Stamp & Eraser">
                  <span className="text-[11px] text-white/50">Kuas</span>
                  {[1, 3, 5].map((n) => (
                    <button key={n} onClick={() => setBrushSize(n, n)}
                      className={`w-7 h-7 rounded text-xs font-medium cursor-pointer ${brushW === n && brushH === n ? 'bg-purple-600 text-white' : 'text-white/60 hover:bg-white/10'}`}>
                      {n}×{n}
                    </button>
                  ))}
                  <input type="number" min={1} max={30} value={brushW}
                    onChange={(e) => setBrushSize(Number(e.target.value) || 1, brushH)}
                    title="Lebar kuas (kotak)"
                    className="w-11 h-7 rounded bg-white/10 text-white text-xs text-center outline-none focus:ring-1 focus:ring-purple-400" />
                  <span className="text-white/40 text-xs">×</span>
                  <input type="number" min={1} max={30} value={brushH}
                    onChange={(e) => setBrushSize(brushW, Number(e.target.value) || 1)}
                    title="Tinggi kuas (kotak)"
                    className="w-11 h-7 rounded bg-white/10 text-white text-xs text-center outline-none focus:ring-1 focus:ring-purple-400" />
                </div>
              </>
            ) : (
              <span className="text-[11px] text-white/50">Drag di kanvas untuk memilih area, lepas untuk menerapkan</span>
            )}
          </>
        )}
        <div className="w-px h-6 bg-white/10" />
        <button onClick={() => useEditorStore.getState().undo()} disabled={undoDepth === 0} title="Undo (Ctrl+Z)" className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 inline-flex items-center justify-center cursor-pointer"><ArrowCounterclockwise size={14} /></button>
        <button onClick={() => useEditorStore.getState().redo()} disabled={redoDepth === 0} title="Redo (Ctrl+Y)" className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 disabled:opacity-30 inline-flex items-center justify-center cursor-pointer"><ArrowClockwise size={14} /></button>
        <span className={`text-[11px] w-32 inline-flex items-center gap-1 ${saveState === 'error' ? 'text-red-400' : saveState === 'saved' ? 'text-emerald-400/90' : 'text-amber-300/90'}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${saveState === 'error' ? 'bg-red-400' : saveState === 'saved' ? 'bg-emerald-400' : 'bg-amber-300 animate-pulse'}`} />
          {saveState === 'saving' ? 'Menyimpan…' : saveState === 'dirty' ? 'Belum tersimpan…' : saveState === 'error' ? 'Gagal — mencoba lagi' : 'Tersimpan otomatis ✓'}
        </span>
        <button onClick={openResize} title="Resize map" className="px-2.5 py-1 rounded text-xs font-medium text-white/70 bg-white/10 hover:bg-white/20 cursor-pointer">Resize</button>
        <button onClick={openImportPicker} title="Upload gambar sendiri sebagai Floor/Wall/Object" className="px-2.5 py-1 rounded text-xs font-medium text-white/70 bg-white/10 hover:bg-white/20 cursor-pointer">Import Image</button>
        <button onClick={() => setRefPanelOpen((v) => !v)} title="Upload denah sebagai referensi untuk digambar ulang manual" className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${refPanelOpen ? 'bg-purple-600 text-white' : 'text-white/70 bg-white/10 hover:bg-white/20'}`}>Reference Image</button>
        <button onClick={() => setScalePanelOpen((v) => !v)} title="Atur ukuran karakter untuk semua pemain di room ini" className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${scalePanelOpen ? 'bg-purple-600 text-white' : 'text-white/70 bg-white/10 hover:bg-white/20'}`}>Ukuran Karakter</button>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => zoomBy(1 / 1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">−</button>
          <span className="text-xs text-white/60 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(1.2)} className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 cursor-pointer">+</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div ref={wrapRef} className="flex-1 min-w-0 relative overflow-hidden" style={{ cursor }}>
          <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag} className="block" style={{ imageRendering: 'pixelated' }} />
          <div className="absolute bottom-3 left-3 text-[11px] text-white/40 pointer-events-none">
            {activeTool === 'copy' ? (clipboard ? 'Copy (C): klik untuk MENEMPEL blok tersalin · Esc untuk memilih area baru' : 'Copy (C): drag area untuk menyalin SEMUA layer (floor, wall, objek, efek)')
              : isObjLayer ? 'Stamp (Q) taruh · Eraser (W) hapus · Select (V) klik+geser pindah, Delete hapus · Copy (C)'
              : activeLayer === 'wall' ? 'Wall: Stamp (Q) pasang (impassable) · Eraser (W) hapus · Select area + Enter/Delete'
              : activeLayer === 'effects' ? 'Tile effects: pilih efek di panel · Stamp gambar · Eraser hapus'
              : 'Stamp (Q) · Eraser (W) · Select (V) + Enter/Delete · Hand (H)/scroll · Copy (C) · Ctrl+Z/Y undo-redo'}
          </div>
        </div>

        <div className="shrink-0 w-64 border-l border-white/10 bg-gray-950/60 p-3 overflow-y-auto">
          {activeLayer === 'floor' && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Tekstur Floor</p>
              <div className="grid grid-cols-4 gap-2">
                <button onClick={() => setSelectedFloor(null)} title="Kosong (default)" className={`h-10 rounded border text-[10px] text-white/60 flex items-center justify-center ${selectedFloor === null ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 hover:border-white/30'}`}>—</button>
                {floorEntries.map((p) => (
                  <button key={p.id} onClick={() => setSelectedFloor(p.id)} title={p.label} className={`h-10 rounded border overflow-hidden ${selectedFloor === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}>
                    <span className="block w-full h-full" style={{ backgroundImage: `url(${p.src})`, backgroundPosition: `-${p.srcX}px -${p.srcY}px`, imageRendering: 'pixelated' }} />
                  </button>
                ))}
              </div>
              {customFloorEntries.length > 0 && (
                <>
                  <p className="text-xs uppercase tracking-wider text-white/40 mt-3 mb-2">Uploads Kamu</p>
                  <div className="grid grid-cols-4 gap-2">
                    {customFloorEntries.map((p) => (
                      <button key={p.id} onClick={() => setSelectedFloor(p.id)} title={p.label} className={`h-10 rounded border overflow-hidden bg-black/20 ${selectedFloor === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}>
                        <span className="block w-full h-full bg-center bg-no-repeat" style={{ backgroundImage: `url(${p.src})`, backgroundSize: 'contain', imageRendering: 'pixelated' }} />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {activeLayer === 'wall' && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Wall</p>
              <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/70 mb-3">
                Gunakan <span className="text-white/90">Stamp (Q)</span> untuk memasang dinding (otomatis <span className="text-red-300">impassable</span> di game) dan <span className="text-white/90">Eraser (W)</span> untuk menghapus. Select + Enter/Delete untuk area.
              </div>
              <p className="text-[11px] text-white/40 mb-2">Tampilan wall yang di-Stamp:</p>
              <div className="grid grid-cols-4 gap-2">
                <button onClick={() => setSelectedWall(null)} title="Default (tampilan tema)" className={`h-10 rounded border text-[10px] text-white/60 flex items-center justify-center ${selectedWall === null ? 'border-purple-400 bg-purple-500/20' : 'border-white/10 hover:border-white/30'}`}>—</button>
                {customWallEntries.map((p) => (
                  <button key={p.id} onClick={() => setSelectedWall(p.id)} title={p.label} className={`h-10 rounded border overflow-hidden bg-black/20 ${selectedWall === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}>
                    <span className="block w-full h-full bg-center bg-no-repeat" style={{ backgroundImage: `url(${p.src})`, backgroundSize: 'contain', imageRendering: 'pixelated' }} />
                  </button>
                ))}
              </div>
              {customWallEntries.length === 0 && <p className="text-[11px] text-white/40 mt-2">Belum ada wall custom — pakai tombol Import Image di atas.</p>}
            </>
          )}

          {/* Fitur 15B — selecting a placed piece (Select tool) swaps the
              palette grid for its own settings panel, mirroring ZEP's
              behavior exactly (a back arrow returns to the palette). */}
          {isObjLayer && selectedObjectId && (
            <ObjectSettingsPanel
              key={selectedObjectId}
              furniture={selectedFurniture}
              layer={selectedFurnitureLayer}
              slug={slug}
              onBack={() => useEditorStore.getState().clearSelectedObject()}
            />
          )}

          {isObjLayer && !selectedObjectId && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">{activeLayer === 'top' ? 'Top objects (di atas avatar)' : 'Objects (di bawah avatar)'}</p>
              <input
                type="text" value={objSearch} onChange={(e) => setObjSearch(e.target.value)} placeholder="Cari objek…"
                className="w-full mb-2 bg-gray-900 border border-white/10 rounded px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-purple-400 outline-none"
              />
              <div className={`flex gap-1 mb-2 ${objQuery && !limezuCat ? 'opacity-40 pointer-events-none' : ''}`}>
                {OBJ_CATEGORIES.map((c) => (
                  <button key={c.key} onClick={() => { setObjTab(c.key); setLimezuCat(''); }} className={`flex-1 py-1 rounded text-[10px] font-medium cursor-pointer ${!limezuCat && objTab === c.key ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>{c.label}</button>
                ))}
                {/* Fitur 15 — this room's uploaded custom objects. */}
                <button onClick={() => { setObjTab('custom'); setLimezuCat(''); }} className={`flex-1 py-1 rounded text-[10px] font-medium cursor-pointer ${!limezuCat && objTab === 'custom' ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}>Uploads Kamu</button>
              </div>
              {/* LimeZu Interiors — 21 themed categories, ~5.400 objects, each
                  category's manifest lazy-fetched on first pick (see
                  limezuInteriors.ts). A dropdown, not more tabs: 21 more tab
                  buttons wouldn't fit this 16rem panel. */}
              <select
                value={limezuCat}
                onChange={(e) => setLimezuCat(e.target.value)}
                className={`w-full mb-2 bg-gray-900 border rounded px-2 py-1 text-xs cursor-pointer outline-none ${limezuCat ? 'border-purple-400 text-white' : 'border-white/10 text-white/50'}`}
              >
                <option value="">Tema LimeZu (5.400+ objek)…</option>
                {LIMEZU_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              {limezuLoading && (
                <p className="text-[11px] text-white/40 mb-2 flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-full border border-white/40 border-t-transparent animate-spin inline-block" /> Memuat objek…
                </p>
              )}
              {objQuery && objEntries.length === 0 && !limezuLoading && <p className="text-[11px] text-white/40 mb-2">Tidak ada objek bernama “{objSearch.trim()}”.</p>}
              {!objQuery && objTab === 'custom' && !limezuCat && objEntries.length === 0 && <p className="text-[11px] text-white/40 mb-2">Belum ada object custom — pakai tombol Import Image di atas.</p>}
              <div className="grid grid-cols-3 gap-2">
                {objEntries.map((p) => (
                  <button key={p.id} onClick={() => setSelectedObject(p.id)} title={p.label} className={`rounded border p-1 flex items-center justify-center bg-black/20 ${selectedObject === p.id ? 'border-purple-400 ring-2 ring-purple-400/50' : 'border-white/10 hover:border-white/30'}`}>
                    <PieceThumb paletteId={p.id} />
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-white/40 mt-3">Kursi ({'>'} bertanda sittable) tetap bisa diduduki di game. Pilih objek lalu Stamp untuk menaruh.</p>
            </>
          )}

          {activeLayer === 'effects' && selectedDoorTile && (
            <DoorSettingsPanel
              key={`${selectedDoorTile.x},${selectedDoorTile.y}`}
              tile={selectedDoorTile}
              doorEffect={useEditorStore.getState().doorEffectAt(selectedDoorTile.x, selectedDoorTile.y)}
              onBack={() => setSelectedDoorTile(null)}
            />
          )}

          {activeLayer === 'effects' && selectedEffect === 'doorArea' && selectedAreaId && selectedDoorArea && (
            <DoorAreaSettingsPanel
              key={selectedAreaId}
              areaId={selectedAreaId}
              doorArea={selectedDoorArea}
              onBack={() => useEditorStore.getState().clearSelectedArea()}
            />
          )}

          {activeLayer === 'effects' && selectedSittableTile && (
            <SittableSettingsPanel
              key={`${selectedSittableTile.x},${selectedSittableTile.y}`}
              tile={selectedSittableTile}
              sittableEffect={useEditorStore.getState().sittableEffectAt(selectedSittableTile.x, selectedSittableTile.y)}
              onBack={() => setSelectedSittableTile(null)}
            />
          )}

          {activeLayer === 'effects' && !selectedDoorTile && !selectedSittableTile && !(selectedEffect === 'doorArea' && selectedAreaId && selectedDoorArea) && (
            <>
              <p className="text-xs uppercase tracking-wider text-white/40 mb-2">Tile Effects</p>
              <div className="space-y-1.5">
                {EFFECTS.map((e) => (
                  <button key={e.id} onClick={() => { setSelectedEffect(e.id); setMediaMode(null); }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm cursor-pointer ${!mediaMode && selectedEffect === e.id ? 'bg-purple-600/30 border border-purple-400 text-white' : 'border border-white/10 text-white/70 hover:bg-white/5'}`}>
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: e.color }} /> {e.label}
                  </button>
                ))}
              </div>
              {/* "Ngobrol dengan CEO" v2 — bookingMode toggle. No dedicated
                  per-zone settings panel exists yet (ZoneRestriction rows are
                  otherwise only ever written once, at area-creation time, see
                  the restrictedArea branch below) — same prompt/confirm
                  convention every other area setting on this page already
                  uses (isolate/capacity/memberOnly above), not a new modal. */}
              {selectedEffect === 'restrictedArea' && (
                <button
                  onClick={async () => {
                    try {
                      const { zones, restrictions } = await adminApi.getZoneRestrictions(slug);
                      const restrictedZones = zones.filter((z) => restrictions.some((r) => r.zoneId === z.id));
                      if (restrictedZones.length === 0) {
                        window.alert('Belum ada Restricted Area di room ini — gambar dulu dengan tool ini, lalu coba lagi.');
                        return;
                      }
                      let target = restrictedZones[0];
                      if (restrictedZones.length > 1) {
                        const names = restrictedZones.map((z) => z.name).join(', ');
                        const picked = (window.prompt(`Ada ${restrictedZones.length} restricted area: ${names}\n\nKetik nama persis salah satu untuk diatur:`, restrictedZones[0].name) ?? '').trim();
                        const found = restrictedZones.find((z) => z.name === picked);
                        if (!found) return;
                        target = found;
                      }
                      const current = restrictions.find((r) => r.zoneId === target.id);
                      const nextBookingMode = !current?.bookingMode;
                      const confirmMsg = nextBookingMode
                        ? `Aktifkan Booking Mode untuk "${target.name}"?\n\nZona ini akan BEBAS keluar-masuk (tidak ada penolakan lagi) — booking (tombol G) & antrean cepat jadi reservasi waktu CEO, bukan syarat fisik masuk.`
                        : `Matikan Booking Mode untuk "${target.name}"?\n\nZona akan kembali terkunci seperti semula (perlu antre untuk masuk).`;
                      if (!window.confirm(confirmMsg)) return;
                      await adminApi.setZoneRestriction(slug, target.id, {
                        enabled: true, minRole: current?.minRole ?? 'admin', queueEnabled: current?.queueEnabled ?? true, bookingMode: nextBookingMode,
                      });
                      window.alert(`Booking Mode untuk "${target.name}" sekarang ${nextBookingMode ? 'AKTIF' : 'nonaktif'}.`);
                    } catch (err) {
                      console.error('[room-editor] failed to toggle booking mode:', err);
                      window.alert('Gagal mengubah setelan Booking Mode.');
                    }
                  }}
                  className="w-full mt-2 py-1.5 rounded bg-purple-600/20 hover:bg-purple-600/30 border border-purple-400/40 text-purple-300 text-xs font-medium cursor-pointer"
                >
                  ⚙️ Atur Booking Mode zona ini
                </button>
              )}
              <button
                onClick={() => {
                  if (window.confirm('Hapus SEMUA tile effect di room ini (impassable, door, sittable, portal, starting point, dll)? Aksi ini bisa di-undo (Ctrl+Z).')) {
                    useEditorStore.getState().resetAllTileEffects();
                  }
                }}
                className="w-full mt-2 py-1.5 rounded bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-red-300 text-xs font-medium cursor-pointer"
              >
                ↺ Reset semua Tile Effects
              </button>

              <p className="text-xs uppercase tracking-wider text-white/40 mt-4 mb-2">Media</p>
              <div className="space-y-1.5">
                {([['image', '🖼️ Insert image'], ['youtube', '▶️ YouTube'], ['website', '🔗 Open website'], ['bgm', '🎵 Background music']] as const).map(([id, label]) => (
                  <button key={id} onClick={() => { setMediaMode(id); setSelectedEffect(null); }}
                    className={`w-full px-2 py-1.5 rounded text-left text-sm cursor-pointer ${mediaMode === id ? 'bg-purple-600/30 border border-purple-400 text-white' : 'border border-white/10 text-white/70 hover:bg-white/5'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-white/50 mt-3 leading-relaxed">
                {mediaMode
                  ? 'Stamp: klik tile untuk menaruh (image/BGM → upload; YouTube/Website → tempel URL). Eraser: klik untuk hapus.'
                  : (EFFECTS.find((e) => e.id === selectedEffect)?.hint ?? 'Pilih efek/media lalu gambar di kanvas. Overlay ini hanya tampil di editor.')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Copy tool: clipboard armed → paste mode */}
      {activeTool === 'copy' && clipboard && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg">
          Tersalin {clipboard.w}×{clipboard.h} — klik untuk menempel
          <button onClick={() => useEditorStore.getState().clearClipboard()} className="ml-2 underline cursor-pointer">pilih ulang (Esc)</button>
        </div>
      )}

      {/* Transient notice (paste clipped / portal caveat) */}
      {notice && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 max-w-md bg-amber-500/95 text-gray-900 text-xs font-medium px-3 py-1.5 rounded-lg shadow-lg pointer-events-none">
          {notice}
        </div>
      )}

      {/* Portal internal-destination hint */}
      {portalHint && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-purple-600 text-white text-xs px-3 py-1.5 rounded-full shadow-lg">
          Klik titik TUJUAN portal di dalam room ini…
          <button onClick={() => { portalOriginRef.current = null; setPortalHint(false); }} className="ml-2 underline cursor-pointer">batal</button>
        </div>
      )}

      {/* Resize modal */}
      {resizeOpen && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60" onMouseDown={() => setResizeOpen(false)}>
          <div className="bg-gray-800 border border-white/10 rounded-xl p-5 w-80" onMouseDown={(e) => e.stopPropagation()}>
            <p className="text-white font-semibold mb-1">Resize map</p>
            <p className="text-white/50 text-xs mb-3">Ukuran dalam tile. Mengecilkan akan memotong konten di luar batas (dikonfirmasi dulu).</p>
            <div className="flex items-center gap-3 mb-4">
              <label className="text-xs text-white/60">Lebar<input type="number" min={1} max={200} value={resizeW} onChange={(e) => setResizeW(Number(e.target.value))} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" /></label>
              <span className="text-white/40 mt-4">×</span>
              <label className="text-xs text-white/60">Tinggi<input type="number" min={1} max={200} value={resizeH} onChange={(e) => setResizeH(Number(e.target.value))} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" /></label>
            </div>
            <div className="flex gap-2">
              <button onClick={applyResize} className="flex-1 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium cursor-pointer">Terapkan</button>
              <button onClick={() => setResizeOpen(false)} className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-sm cursor-pointer">Batal</button>
            </div>
          </div>
        </div>
      )}

      {/* Fitur 15 — Import Image: category picker shown right after the file
          is picked and validated (size/type already checked in
          openImportPicker before this even opens). */}
      {importOpen && importFile && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60" onMouseDown={() => !importBusy && setImportOpen(false)}>
          <div className="bg-gray-800 border border-white/10 rounded-xl p-5 w-80" onMouseDown={(e) => e.stopPropagation()}>
            <p className="text-white font-semibold mb-1">Import Image</p>
            <p className="text-white/50 text-xs mb-3 truncate">{importFile.name} ({(importFile.size / 1024).toFixed(0)}KB)</p>
            <label className="text-xs text-white/60 block mb-3">
              Nama
              <input type="text" value={importLabel} onChange={(e) => setImportLabel(e.target.value)} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" />
            </label>
            <p className="text-xs text-white/60 mb-1.5">Dipakai sebagai:</p>
            <div className="flex gap-1.5 mb-4">
              {([['floor', 'Floor'], ['wall', 'Wall'], ['object', 'Object']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setImportCategory(id)} className={`flex-1 py-1.5 rounded text-xs font-medium cursor-pointer ${importCategory === id ? 'bg-purple-600 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'}`}>{label}</button>
              ))}
            </div>
            {importErr && <p className="text-red-400 text-xs mb-3">{importErr}</p>}
            <div className="flex gap-2">
              <button onClick={confirmImport} disabled={importBusy} className="flex-1 py-1.5 rounded bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium cursor-pointer">{importBusy ? 'Mengupload…' : 'Import'}</button>
              <button onClick={() => setImportOpen(false)} disabled={importBusy} className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white/80 text-sm cursor-pointer">Batal</button>
            </div>
          </div>
        </div>
      )}

      {/* Reference Image — floating, non-blocking panel (no backdrop) so the
          canvas stays interactive while opacity/position are being tuned
          against the traced result underneath. */}
      {refPanelOpen && (
        <div className="absolute top-14 right-4 z-10 bg-gray-800 border border-white/10 rounded-xl p-4 w-72 shadow-2xl">
          <p className="text-white font-semibold mb-2 text-sm">Reference Image</p>
          {!referenceImage ? (
            <>
              <p className="text-white/50 text-xs mb-3">Upload foto/gambar denah. Bisa dipakai cuma sebagai panduan trace di editor, atau diaktifkan biar gambarnya beneran jadi background map di game (tinggal atur collision-nya pakai tile effect &quot;Impassable&quot;).</p>
              {refErr && <p className="text-red-400 text-xs mb-2">{refErr}</p>}
              <button onClick={uploadReferenceImage} disabled={refBusy} className="w-full py-1.5 rounded bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium cursor-pointer">{refBusy ? 'Mengupload…' : 'Upload Denah'}</button>
            </>
          ) : (
            <>
              <label className="text-xs text-white/60 flex items-center justify-between mb-2">
                Opacity
                <input type="range" min={0} max={100} value={Math.round(referenceImage.opacity * 100)} onChange={(e) => useEditorStore.getState().updateReferenceImage({ opacity: Number(e.target.value) / 100 })} className="ml-2 flex-1 cursor-pointer" />
                <span className="ml-2 w-9 text-right tabular-nums">{Math.round(referenceImage.opacity * 100)}%</span>
              </label>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <label className="text-xs text-white/60">X (px)
                  <input type="number" value={Math.round(referenceImage.x)} onChange={(e) => useEditorStore.getState().updateReferenceImage({ x: Number(e.target.value) })} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" />
                </label>
                <label className="text-xs text-white/60">Y (px)
                  <input type="number" value={Math.round(referenceImage.y)} onChange={(e) => useEditorStore.getState().updateReferenceImage({ y: Number(e.target.value) })} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" />
                </label>
                <label className="text-xs text-white/60">Lebar (px)
                  <input type="number" min={1} value={Math.round(referenceImage.width)} onChange={(e) => useEditorStore.getState().updateReferenceImage({ width: Math.max(1, Number(e.target.value)) })} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" />
                </label>
                <label className="text-xs text-white/60">Tinggi (px)
                  <input type="number" min={1} value={Math.round(referenceImage.height)} onChange={(e) => useEditorStore.getState().updateReferenceImage({ height: Math.max(1, Number(e.target.value)) })} className="mt-1 w-full bg-gray-900 border border-white/10 rounded px-2 py-1 text-sm text-white" />
                </label>
              </div>
              <button
                onClick={() => {
                  const doc = useEditorStore.getState().doc; if (!doc) return;
                  // Grid misalignment fix — reset the reference image's own
                  // pixel rectangle back to exactly cover the room's tile
                  // grid (this is also the default set on first upload, see
                  // uploadReferenceImage). A dragged/resized image drifting
                  // out of sync with the grid is a data problem, not a
                  // render bug (grid lines, tile-effect placement, and this
                  // image all already share the same pan/zoom transform) —
                  // this button just gets the numbers back in sync.
                  useEditorStore.getState().updateReferenceImage({ x: 0, y: 0, width: doc.width * TILE_SIZE, height: doc.height * TILE_SIZE });
                }}
                title="Kembalikan gambar supaya PAS membentang ke seluruh grid map — pakai ini kalau garis grid kelihatan meleset dari gambar"
                className="w-full mb-2 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs font-medium cursor-pointer"
              >
                Fit ke Grid
              </button>
              <label className="flex items-center gap-2 mb-3 text-xs text-white/60 cursor-pointer">
                <input type="checkbox" checked={!!referenceImage.showInGame} onChange={(e) => useEditorStore.getState().updateReferenceImage({ showInGame: e.target.checked })} className="cursor-pointer" />
                Tampilkan di game (jadi background map untuk semua pemain)
              </label>
              <div className="flex gap-2">
                <button onClick={() => useEditorStore.getState().updateReferenceImage({ visible: !referenceImage.visible })} className="flex-1 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs font-medium cursor-pointer">{referenceImage.visible ? 'Sembunyikan' : 'Tampilkan'}</button>
                <button onClick={() => useEditorStore.getState().setReferenceImage(null)} className="flex-1 py-1.5 rounded bg-red-600/80 hover:bg-red-600 text-white text-xs font-medium cursor-pointer">Hapus</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Ukuran Karakter — floating panel, anchored left so it never overlaps
          the Reference Image panel (anchored right) if both are open. */}
      {scalePanelOpen && (
        <div className="absolute top-14 left-4 z-10 bg-gray-800 border border-white/10 rounded-xl p-4 w-72 shadow-2xl">
          <p className="text-white font-semibold mb-2 text-sm">Ukuran Karakter</p>
          <p className="text-white/50 text-xs mb-3">Atur besar/kecil avatar untuk SEMUA pemain di room ini. Cuma tampilan, tidak mengubah collision/hitbox.</p>
          <label className="text-xs text-white/60 flex items-center justify-between">
            Skala
            <input
              type="range"
              min={Math.round(AVATAR_SCALE_MIN * 100)}
              max={Math.round(AVATAR_SCALE_MAX * 100)}
              value={Math.round(avatarScale * 100)}
              onChange={(e) => useEditorStore.getState().setAvatarScale(Number(e.target.value) / 100)}
              className="ml-2 flex-1 cursor-pointer"
            />
            <span className="ml-2 w-11 text-right tabular-nums">{Math.round(avatarScale * 100)}%</span>
          </label>
          {avatarScale !== 1 && (
            <button onClick={() => useEditorStore.getState().setAvatarScale(1)} className="mt-3 w-full py-1.5 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs font-medium cursor-pointer">Reset ke 100%</button>
          )}
        </div>
      )}
    </div>
  );
}
