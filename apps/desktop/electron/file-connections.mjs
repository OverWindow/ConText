// File connections are device-local preferences; scans must not reset them.
export const fileConnectionKey = (workspaceId, entryId) => `disconnected-file:${workspaceId}:${entryId}`;
export const deviceConnectedEntrySQL = (alias = 'e') => `NOT EXISTS (
  SELECT 1 FROM local_settings connection WHERE connection.key='disconnected-file:' || ${alias}.workspace_id || ':' || ${alias}.id AND ${alias}.kind='file'
)`;
export const connectedEntrySQL = (alias = 'e') => `${deviceConnectedEntrySQL(alias)} AND NOT EXISTS (
  SELECT 1 FROM unified_entities logical WHERE logical.workspace_id=${alias}.workspace_id
    AND logical.layer='view' AND logical.collection='entries' AND logical.entity_id=${alias}.id
    AND json_extract(logical.value,'$.deleted_at') IS NOT NULL
)`;
