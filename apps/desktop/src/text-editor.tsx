import { useMemo } from 'react';
import { TextEditor } from '@context/workspace-ui/shared/ui/text-editor';
import type { Entry } from './contracts';

export function LocalTextEditor({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const repository = useMemo(() => ({
    load: () => window.contextDesktop.readTextFile(entry.workspace_id, entry.id),
    save: (revision: string, text: string) => window.contextDesktop.saveTextFile(entry.workspace_id, entry.id, revision, text),
    saveAs: (text: string) => window.contextDesktop.saveTextAs(entry.workspace_id, entry.id, text),
  }), [entry.workspace_id, entry.id]);
  return <TextEditor repository={repository} onClose={onClose} />;
}
