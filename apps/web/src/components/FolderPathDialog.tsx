import { useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input } from '@open-design/components';
import { useT } from '../i18n';
import { validateLinkedDir } from '../providers/registry';
import styles from './FolderPathDialog.module.css';

interface Props {
  initialError?: string;
  onSelect: (path: string | null) => void;
}

export function FolderPathDialog({ initialError, onSelect }: Props) {
  const t = useT();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState(initialError ?? '');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const previousFocus = document.activeElement;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onSelect(null);
      }
      if (event.key === 'Tab') {
        const dialog = inputRef.current?.closest('form');
        const controls = dialog?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (!dialog?.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      requestRef.current?.abort();
      requestRef.current = null;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [onSelect]);

  async function confirm() {
    if (!path.trim() || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true);
    setError('');
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const canonical = await validateLinkedDir(path, controller.signal);
      if (!controller.signal.aborted) onSelect(canonical);
    } catch (err) {
      if (requestRef.current === controller) setError(err instanceof Error ? err.message : String(err));
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) { requestRef.current = null; setPending(false); }
    }
  }

  return (
    <Dialog as="form" className={styles.dialog} ariaLabelledBy={`${id}-title`} ariaDescribedBy={`${id}-hint`} onClose={() => onSelect(null)} onSubmit={(event) => { event.preventDefault(); void confirm(); }} data-testid="folder-path-dialog">
      <DialogHeader><DialogTitle id={`${id}-title`}>{t('homeWorkingDir.enterPath')}</DialogTitle></DialogHeader>
      <DialogBody className={styles.body}>
        <DialogDescription id={`${id}-hint`}>{t('homeWorkingDir.pathHint')}</DialogDescription>
        <Input ref={inputRef} aria-label={t('homeWorkingDir.enterPath')} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : `${id}-hint`} value={path} onChange={(event) => { setPath(event.target.value); setError(''); }} autoComplete="off" spellCheck={false} disabled={pending} required data-testid="folder-path-input" />
        {error ? <p className={styles.error} id={`${id}-error`} role="alert">{error}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button onClick={() => onSelect(null)}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={pending || !path.trim()} aria-busy={pending} data-testid="folder-path-confirm">{t('homeWorkingDir.pick')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
