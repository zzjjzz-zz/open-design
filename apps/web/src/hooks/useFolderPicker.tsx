import { useCallback, useEffect, useRef, useState } from 'react';
import { isOpenDesignHostAvailable } from '@open-design/host';
import { FolderPathDialog } from '../components/FolderPathDialog';
import { openFolderDialog, validateLinkedDir } from '../providers/registry';
import { folderPickerErrorDetails } from '../utils/folderPicker';

/** All browser paths are entered on the daemon's device, then canonicalized. */
export function useFolderPicker() {
  const [request, setRequest] = useState<{ id: number; error?: string } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const resolveRef = useRef<((path: string | null) => void) | null>(null);
  const settle = useCallback((path: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    resolve?.(path);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolveRef.current?.(null);
      resolveRef.current = null;
    };
  }, []);
  const requestFolderPath = useCallback((error?: string) => {
    if (!mounted.current) return Promise.resolve(null);
    resolveRef.current?.(null);
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
      setRequest({ id: ++sequence.current, ...(error ? { error } : {}) });
    });
  }, []);
  const pickFolder = useCallback(async (): Promise<string | null> => {
    // A native picker on a remote daemon opens on the wrong device. Desktop
    // has a host bridge; browser sessions always use the explicit path form.
    if (!isOpenDesignHostAvailable()) return requestFolderPath();
    try {
      const path = await openFolderDialog({ throwOnError: true });
      if (!mounted.current) return null;
      const canonical = path ? await validateLinkedDir(path) : null;
      return mounted.current ? canonical : null;
    } catch (error) {
      return requestFolderPath(folderPickerErrorDetails(error));
    }
  }, [requestFolderPath]);
  return {
    pickFolder,
    requestFolderPath,
    folderPickerDialog: request ? <FolderPathDialog key={request.id} initialError={request.error} onSelect={settle} /> : null,
  };
}
