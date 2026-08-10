import { contextBridge, ipcRenderer } from 'electron';
import type { OperatorReply, Snapshot } from '../shared/ipc.js';

/** renderer 只能经这里够到 main —— contextIsolation 开、nodeIntegration 关。 */
contextBridge.exposeInMainWorld('inquestry', {
  envCheck: () => ipcRenderer.invoke('env:check'),
  start: (question: string) => ipcRenderer.invoke('case:start', question),
  send: (text: string) => ipcRenderer.invoke('case:send', text),
  interrupt: () => ipcRenderer.invoke('case:interrupt'),
  answerOperator: (reply: OperatorReply) => ipcRenderer.invoke('case:answerOperator', reply),
  snapshot: () => ipcRenderer.invoke('case:snapshot'),
  excerpt: (callId: string, anchor: string | null) => ipcRenderer.invoke('case:excerpt', callId, anchor),
  onSnapshot: (cb: (s: Snapshot) => void) => {
    const handler = (_e: unknown, s: Snapshot) => cb(s);
    ipcRenderer.on('snapshot', handler);
    return () => ipcRenderer.off('snapshot', handler);
  },
});
