import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, FileEarmarkFill } from 'react-bootstrap-icons';

// Bug 10 — in-app lightbox for chat attachments (was: open in a new browser
// tab). Shared by ChatPanel and MessengerApp so both surfaces behave the same.
// It only changes how a file is DISPLAYED — the URL still points at the same
// MeetKai backend proxy in front of Lark Drive (A8), and the browser sends the
// same auth cookie for <img>/<video>/<iframe>/download, so old and new
// messages resolve identically.

const IMAGE_RE = /\.(png|jpe?g|gif|webp)(\?|$)/i;
const VIDEO_RE = /\.(mp4|webm|mov|avi)(\?|$)/i;
const PDF_RE = /\.pdf(\?|$)/i;

export interface LightboxTarget {
  url: string;
  fileName?: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentLightbox({ target, onClose }: { target: LightboxTarget; onClose: () => void }) {
  const { url } = target;
  const name = target.fileName || decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'file');
  const isImage = IMAGE_RE.test(url);
  const isVideo = VIDEO_RE.test(url);
  const isPdf = PDF_RE.test(url);
  const previewable = isImage || isVideo || isPdf;

  // Esc closes, matching the click-outside affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Best-effort file size for the non-previewable info card (nama + ukuran).
  // A HEAD to the same-origin backend carries the auth cookie; if it fails or
  // omits content-length we simply don't show a size — never blocks the card.
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (previewable) return;
    let alive = true;
    fetch(url, { method: 'HEAD', credentials: 'include' })
      .then((r) => { const len = r.headers.get('content-length'); if (alive && len) setSize(Number(len)); })
      .catch(() => { /* size is optional */ });
    return () => { alive = false; };
  }, [url, previewable]);

  const downloadBtn = (
    <a
      href={url}
      download={name}
      onMouseDown={(e) => e.stopPropagation()}
      title="Unduh"
      className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 text-white backdrop-blur cursor-pointer"
    >
      <Download size={18} />
    </a>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      {/* Toolbar always available (download + close), even for a plain image. */}
      <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
        {previewable && downloadBtn}
        <button
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          title="Tutup (Esc)"
          className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 text-white backdrop-blur cursor-pointer"
        >
          <X size={20} />
        </button>
      </div>

      {/* Inner content stops propagation so a click ON the media doesn't close;
          clicking the dark area around it does (handled by the overlay above). */}
      <div className="max-w-[92vw] max-h-[88vh] flex items-center justify-center" onMouseDown={(e) => e.stopPropagation()}>
        {isImage ? (
          <img src={url} alt={name} className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg" />
        ) : isVideo ? (
          <video src={url} controls autoPlay className="max-w-[92vw] max-h-[88vh] rounded-lg bg-black" />
        ) : isPdf ? (
          <iframe src={url} title={name} className="w-[92vw] h-[88vh] rounded-lg bg-white" />
        ) : (
          // Non-previewable (.docx/.zip/…): small info card + download, never a
          // silent hop to a new tab.
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-xs text-center shadow-2xl">
            <FileEarmarkFill size={40} className="mx-auto text-purple-500 mb-3" />
            <p className="text-gray-800 dark:text-gray-100 text-sm font-medium break-all mb-1">{name}</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs mb-4">
              {size != null ? humanSize(size) + ' · ' : ''}Tidak bisa dipratinjau di sini.
            </p>
            <a
              href={url}
              download={name}
              className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium px-4 py-2 rounded-lg cursor-pointer"
            >
              <Download size={15} /> Unduh
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
