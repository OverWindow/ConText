const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (method, ...args) => {
  const result = await ipcRenderer.invoke(`context:${method}`, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('contextDesktop', {
  list: () => invoke('list'), connect: () => invoke('connect'),
  snapshot: id => invoke('snapshot', id), refresh: id => invoke('refresh', id),
  relink: id => invoke('relink', id), disconnect: id => invoke('disconnect', id),
  settings: (id, value) => invoke('settings', id, value),
  savePositions: (id, positions) => invoke('savePositions', id, positions),
  saveView: (id, directory, view) => invoke('saveView', id, directory, view),
  preview: (id, file, small = false) => invoke('preview', id, file, small),
  open: (id, file) => invoke('open', id, file), reveal: (id, file) => invoke('reveal', id, file),
  onChanged: callback => { const listener = (_event, id) => callback(id); ipcRenderer.on('context:changed', listener); return () => ipcRenderer.removeListener('context:changed', listener); },
});
