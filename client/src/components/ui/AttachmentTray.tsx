import { XLg, FileEarmarkFill, CameraVideoFill } from 'react-bootstrap-icons';
import type { PendingAttachment } from '@/hooks/usePendingAttachments';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extLabel(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toUpperCase() : 'FILE';
}

interface AttachmentTrayProps {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
}

// Staging tray shown between "paste/attach" and "Kirim" — review, add more,
// remove — rendered above the compose input by both ChatPanel and
// MessengerApp. Sending itself stays in each caller: zone chat vs.
// persisted channel/DM chat upload through different paths.
export function AttachmentTray({ items, onRemove }: AttachmentTrayProps) {
  if (items.length === 0) return null;
  return (
    <div className="px-3 pb-2 flex flex-wrap gap-2">
      {items.map(({ id, file, previewUrl }) => {
        const isImage = !!previewUrl;
        const isVideo = !isImage && file.type.startsWith('video/');
        return (
          <div key={id} className="relative">
            {isImage ? (
              <img
                src={previewUrl}
                alt={file.name}
                className="w-14 h-14 object-cover rounded border border-purple-100 dark:border-gray-600"
              />
            ) : (
              <div className="w-40 h-14 flex items-center gap-2 px-2 rounded border border-purple-100 dark:border-gray-600 bg-purple-50/50 dark:bg-gray-700/50">
                {isVideo
                  ? <CameraVideoFill size={16} className="text-purple-500 shrink-0" />
                  : <FileEarmarkFill size={16} className="text-purple-500 shrink-0" />}
                <div className="min-w-0">
                  <p className="text-[10px] text-gray-700 dark:text-gray-200 truncate" title={file.name}>{file.name}</p>
                  <p className="text-[9px] text-gray-400">{extLabel(file.name)} · {formatBytes(file.size)}</p>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => onRemove(id)}
              title="Hapus lampiran"
              className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-gray-700 text-white cursor-pointer"
            >
              <XLg size={8} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
