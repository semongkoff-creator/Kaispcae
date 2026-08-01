import { useState } from 'react';
import { X } from 'react-bootstrap-icons';
import { Furniture, InteractivePasswordResultPayload, InteractiveChoiceResultPayload } from '@virtualmeet/shared';

interface InteractiveObjectModalProps {
  furniture: Furniture;
  onClose: () => void;
  // Fitur 15B — only meaningful for interactiveType === 'password'/'multiple_choice'.
  // The real password / isCorrect flags never reach this component at all
  // (see redactInteractiveSecrets server-side) — both are checked over the
  // socket, never compared locally.
  onCheckPassword: (furnitureId: string, attempt: string) => void;
  passwordResult: InteractivePasswordResultPayload | null;
  onCheckChoice: (furnitureId: string, selectedIndex: number) => void;
  choiceResult: InteractiveChoiceResultPayload | null;
}

// Fitur 15B — renders whichever Interactive Object type triggered. Only
// 'text_popup'/'image_popup'/'password'/'multiple_choice' have a modal of
// their own so far ('website' opens a real window instead — see App.tsx's
// handleInteractiveTrigger). More of ZEP's developer types each get their
// own branch here as they're implemented (same one-component-per-modal-
// family pattern as MediaViewerModal).
export function InteractiveObjectModal({ furniture, onClose, onCheckPassword, passwordResult, onCheckChoice, choiceResult }: InteractiveObjectModalProps) {
  const isImage = furniture.interactiveType === 'image_popup';
  const isPassword = furniture.interactiveType === 'password';
  const isChoice = furniture.interactiveType === 'multiple_choice';
  const [attempt, setAttempt] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const pwResult = passwordResult && passwordResult.furnitureId === furniture.id ? passwordResult : null;
  const chResult = choiceResult && choiceResult.furnitureId === furniture.id ? choiceResult : null;

  const submitPassword = () => {
    if (!attempt) return;
    onCheckPassword(furniture.id, attempt);
  };
  const submitChoice = () => {
    if (selectedIndex == null) return;
    onCheckChoice(furniture.id, selectedIndex);
  };

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

        {isPassword && (
          pwResult?.correct ? (
            // Correct — same rendering as text_popup, using the piece's
            // own correctText (ZEP's "Set Action After Password Entered").
            <p className="text-gray-800 dark:text-gray-100 text-sm whitespace-pre-wrap">{pwResult.correctText || ''}</p>
          ) : (
            <>
              {furniture.interactiveConfig?.passwordDescription && (
                <p className="text-gray-600 dark:text-gray-300 text-sm mb-3">{furniture.interactiveConfig.passwordDescription}</p>
              )}
              <input
                type="password" value={attempt} onChange={(e) => setAttempt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitPassword(); }}
                placeholder="Password"
                autoFocus
                className="w-full mb-2 bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-white/10 rounded px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:border-purple-400"
              />
              {pwResult && !pwResult.correct && (
                <p className="text-red-500 text-xs mb-2">{pwResult.failureMessage || 'Password salah.'}</p>
              )}
              <button
                onClick={submitPassword}
                className="w-full py-2 rounded bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium cursor-pointer"
              >
                Submit
              </button>
            </>
          )
        )}

        {isChoice && (
          chResult?.correct ? (
            // Correct — same rendering as text_popup, using the piece's own
            // correctText (ZEP's "Set Action After Choosing Correct Answer").
            <p className="text-gray-800 dark:text-gray-100 text-sm whitespace-pre-wrap">{chResult.correctText || ''}</p>
          ) : (
            <>
              {furniture.interactiveConfig?.question && (
                <p className="text-gray-800 dark:text-gray-100 text-sm mb-3">{furniture.interactiveConfig.question}</p>
              )}
              <div className="space-y-1.5 mb-2">
                {(furniture.interactiveConfig?.options ?? []).map((opt, i) => (
                  <label key={i} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input type="radio" name="mc-option" checked={selectedIndex === i} onChange={() => setSelectedIndex(i)} />
                    {opt.text}
                  </label>
                ))}
              </div>
              {chResult && !chResult.correct && (
                <p className="text-red-500 text-xs mb-2">{chResult.incorrectMessage || 'Jawaban salah.'}</p>
              )}
              <button
                onClick={submitChoice}
                disabled={selectedIndex == null}
                className="w-full py-2 rounded bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium cursor-pointer"
              >
                Submit
              </button>
            </>
          )
        )}
      </div>
    </div>
  );
}
