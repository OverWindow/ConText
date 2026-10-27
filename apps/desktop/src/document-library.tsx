import { DocumentLibrary } from '@context/workspace-ui/document-library';
import type { DisconnectedFile, Entry } from './contracts';
export function LocalDocumentLibrary({ workspaceId, ...props }: { workspaceId: string; entries: Entry[]; disconnectedFiles: DisconnectedFile[]; onOpen: (entry: Entry) => void; onClose: () => void; onCreate: () => void }) {
  return <DocumentLibrary {...props} onDisconnect={id => window.contextDesktop.disconnectFile(workspaceId, id)} onReconnect={id => window.contextDesktop.reconnectFile(workspaceId, id)} />;
}
