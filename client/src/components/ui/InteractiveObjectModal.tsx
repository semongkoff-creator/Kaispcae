import { X } from 'react-bootstrap-icons';
import { Furniture } from '@virtualmeet/shared';

interface InteractiveObjectModalProps {
  furniture: Furniture;
  onClose: () => void;
}

// Fitur 15B — renders whichever Interactive Object type triggered. Only
// 'text_popup'/'image_popup' exist so far; more of ZEP's pop-up/website/
// developer types each get their own branch here as they're implemented
// (same one-component-per-modal-family pattern as MediaViewerModal).
export function InteractiveObjectModal({ furniture, onClose }: InteractiveObjectModalProps) {
  const isImage = furniture.interactiveType === 'image_popup';
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className={`bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-4 w-full mx-4 max-h-[85vh] overflow-y-auto ${isImage ? 'max-w-lg' : 'max-w-md'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-gray-400 dark:text-gray-500 text-xs">{furniture.name || ' '}</span>
          <button onClick={onClose} title="Close" className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {furniture.interactiveType === 'text_popup' && (
          <p className="text-gray-800 dark:text-gray-100 text-sm whitespace-pre-wrap">{furniture.interactiveConfig?.text || ''}</p>
        )}

        {isImage && furniture.interactiveConfig?.imageUrl && (
          <img src={furniture.interactiveConfig.imageUrl} alt="" className="w-full max-h-[70vh] object-contain rounded-lg" />
        )}
      </div>
    </div>
  );
}
