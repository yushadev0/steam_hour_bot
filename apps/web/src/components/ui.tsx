import { LoaderCircle, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { Tone } from '../status';
import { toneRing } from '../status';

/** Yerel <dialog> üzerine kurulu modal: Esc ile kapanır, odak içeride kalır. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  fixedBody = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Kaydırılan içeriğin altında hep görünen alan (ör. Kaydet düğmeleri) */
  footer?: ReactNode;
  wide?: boolean;
  /** true ise gövde kaymaz; içerik kendi kaydırma alanını yönetir */
  fixedBody?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-md bg-surface p-0 text-text shadow-2xl shadow-black/60 backdrop:bg-black/70`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-lg font-semibold text-bright">{title}</h2>
            <button className="btn-ghost -mr-2" onClick={onClose} aria-label={t('Kapat', 'Close')}>
              <X size={18} />
            </button>
          </header>
          <div className={`min-h-0 flex-1 px-5 py-4 ${fixedBody ? 'flex flex-col' : 'overflow-y-auto'}`}>{children}</div>
          {footer && <footer className="border-t border-line px-5 py-3.5">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="animate-spin" aria-hidden />;
}

/** Steam profil resmi; çerçeve rengi durumu gösterir (arkadaş listesindeki gibi). */
export function Avatar({ src, name, tone, size = 40 }: { src: string | null; name: string; tone: Tone; size?: number }) {
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-[3px] border-2 bg-raised ${toneRing[tone]}`}
      style={{ width: size, height: size }}
    >
      {src ? (
        <img src={src} alt="" width={size} height={size} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-semibold text-muted" style={{ fontSize: size * 0.42 }}>
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-ingame' : 'bg-[#3d4450]'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-bright shadow transition-transform ${checked ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm bg-bar p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`inline-flex items-center gap-1.5 rounded-[2px] px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            value === option.value ? 'bg-raised text-bright' : 'text-muted hover:text-text'
          }`}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-3 rounded-sm bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

// --- Bildirimler ---

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`max-w-sm rounded-sm border-l-4 bg-raised px-4 py-2.5 text-sm text-bright shadow-lg shadow-black/40 ${
              toast.tone === 'error' ? 'border-danger' : 'border-ingame'
            }`}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
