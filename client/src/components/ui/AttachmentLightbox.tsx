import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, FileEarmarkFill, ExclamationTriangleFill } from 'react-bootstrap-icons';

// Bug 10 — in-app lightbox for chat attachments (was: open in a new browser
// tab). Shared by ChatPanel and MessengerApp so both surfaces behave the same.
// It only changes how a file is DISPLAYED — the URL still points at the same
// backend upload route, and the browser sends the
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
  // Bug 17 — detect by the ORIGINAL FILENAME first, not the URL. An
  // attachment URL is not guaranteed to carry a file extension, and testing
  // the URL alone made every such image/video read as "not previewable". The
  // filename (attachmentName) keeps its real extension, so it's the reliable
  // signal; the URL is only a fallback.
  const matchExt = (re: RegExp) => re.test(name) || re.test(url);
  const isImage = matchExt(IMAGE_RE);
  const isVideo = matchExt(VIDEO_RE);
  const isPdf = matchExt(PDF_RE);
  const previewable = isImage || isVideo || isPdf;

  // Esc closes, matching the click-outside affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Bug 17 — if a previewable file fails to actually load (broken/failed upload),
  // say so honestly instead of silently showing a blank frame.
  const [loadFailed, setLoadFailed] = useState(false);

  // Best-effort file size for the non-previewable info card. Only trust it when
  // the response is OK — a failed/gated response body (e.g. a short error JSON)
  // must NOT be shown as if it were the file's real size (that's what made a
  // healthy PNG look like "35 B"). A HEAD to the same-origin backend carries the
  // auth cookie; if it fails or omits content-length we simply show no size.
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (previewable) return;
    let alive = true;
    fetch(url, { method: 'HEAD', credentials: 'include' })
      .then((r) => {
        const len = r.headers.get('content-length');
        if (alive && r.ok && len) setSize(Number(len));
      })
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

  const showPreview = previewable && !loadFailed;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      {/* Toolbar always available (download + close), even for a plain image. */}
      <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
        {showPreview && downloadBtn}
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
        {showPreview && isImage ? (
          <img src={url} alt={name} onError={() => setLoadFailed(true)} className="max-w-[92vw] max-h-[88vh] object-contain rounded-lg" />
        ) : showPreview && isVideo ? (
          <video src={url} controls autoPlay onError={() => setLoadFailed(true)} className="max-w-[92vw] max-h-[88vh] rounded-lg bg-black" />
        ) : showPreview && isPdf ? (
          <iframe src={url} title={name} className="w-[92vw] h-[88vh] rounded-lg bg-white" />
        ) : (
          // Non-previewable (.docx/.zip/…) OR a previewable file that failed to
          // load. In the latter case be honest that it may be a failed upload,
          // rather than implying the file is fine but just can't be shown.
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-xs text-center shadow-2xl">
            {loadFailed ? (
              <ExclamationTriangleFill size={38} className="mx-auto text-amber-500 mb-3" />
            ) : (
              <FileEarmarkFill size={40} className="mx-auto text-purple-500 mb-3" />
            )}
            <p className="text-gray-800 dark:text-gray-100 text-sm font-medium break-all mb-1">{name}</p>
            <p className="text-gray-400 dark:text-gray-500 text-xs mb-4">
              {loadFailed
                ? 'File gagal dimuat — kemungkinan gagal terupload. Coba kirim ulang.'
                : `${size != null ? humanSize(size) + ' · ' : ''}Tidak bisa dipratinjau di sini.`}
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
