/* Short, useful toasts: what happened, the one figure that matters, and a
 * link to the proof. Announced politely; errors assertively. */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import s from './Toast.module.css';

interface Toast { id: number; tone: 'ok' | 'error' | 'info'; title: string; detail?: string; href?: string; hrefLabel?: string }
const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(Ctx);

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems(xs => xs.filter(x => x.id !== id)), []);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++seq;
    setItems(xs => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => dismiss(id), t.tone === 'error' ? 9000 : 6000);
  }, [dismiss]);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className={s.region} aria-live="polite" aria-relevant="additions">
        {items.map(t => (
          <div key={t.id} className={s.toast} data-tone={t.tone} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span className={s.mark} aria-hidden="true">
              <Icon name={t.tone === 'ok' ? 'check' : t.tone === 'error' ? 'close' : 'info'} size={12} />
            </span>
            <div>
              <p className={s.title}>{t.title}</p>
              {t.detail && <p className={`${s.detail} num`}>{t.detail}</p>}
              {t.href && (
                <a className={s.link} href={t.href} target="_blank" rel="noreferrer">
                  {t.hrefLabel ?? 'View transaction'} <Icon name="external" size={12} />
                </a>
              )}
            </div>
            <button className={s.x} onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="close" size={14} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
