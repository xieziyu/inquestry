import { contextBridge, ipcRenderer } from 'electron';
import type {
  CaseListQuery,
  GateDecision,
  InquestryApi,
  IntakeDraft,
  OperatorReply,
  Snapshot,
} from '../shared/ipc.js';
import type { UiSettings } from '../shared/settings.js';
import type { UpdateStatus } from '../shared/update.js';

/** renderer 只能经这里够到 main —— contextIsolation 开、nodeIntegration 关。 */
const api: InquestryApi = {
  envCheck: () => ipcRenderer.invoke('env:check'),
  intakeOptions: () => ipcRenderer.invoke('intake:options'),
  pickProjectRoot: () => ipcRenderer.invoke('intake:pickRoot'),
  createCase: (draft: IntakeDraft) => ipcRenderer.invoke('case:create', draft),
  renameCase: (caseId: string, title: string) => ipcRenderer.invoke('case:rename', caseId, title),
  switchCase: (caseId: string) => ipcRenderer.invoke('case:switch', caseId),
  newCase: () => ipcRenderer.invoke('case:new'),
  start: (caseId: string, question?: string) => ipcRenderer.invoke('case:start', caseId, question),
  restart: (caseId: string) => ipcRenderer.invoke('case:restart', caseId),
  setTakeover: (caseId: string, on: boolean) => ipcRenderer.invoke('case:takeover', caseId, on),
  send: (caseId: string, text: string) => ipcRenderer.invoke('case:send', caseId, text),
  interrupt: (caseId: string) => ipcRenderer.invoke('case:interrupt', caseId),
  stopLane: (caseId: string, lane: string) => ipcRenderer.invoke('case:stopLane', caseId, lane),
  requestClosing: (caseId: string) => ipcRenderer.invoke('case:requestClosing', caseId),
  closeCase: (caseId: string) => ipcRenderer.invoke('case:close', caseId),
  archiveCase: (caseId: string) => ipcRenderer.invoke('case:archive', caseId),
  deleteCase: (caseId: string) => ipcRenderer.invoke('case:delete', caseId),
  answerOperator: (caseId: string, reply: OperatorReply) =>
    ipcRenderer.invoke('case:answerOperator', caseId, reply),
  decideGate: (caseId: string, d: GateDecision) => ipcRenderer.invoke('case:decideGate', caseId, d),
  exportMarkdown: (caseId: string) => ipcRenderer.invoke('case:exportMarkdown', caseId),
  exportImage: (caseId: string) => ipcRenderer.invoke('case:exportImage', caseId),
  exportPayload: (token: string) => ipcRenderer.invoke('export:payload', token),
  searchCases: (term: string) => ipcRenderer.invoke('case:search', term),
  snapshot: () => ipcRenderer.invoke('case:snapshot'),
  excerpt: (callId: string, anchor: string | null) => ipcRenderer.invoke('case:excerpt', callId, anchor),
  listCases: (q: CaseListQuery) => ipcRenderer.invoke('case:list', q),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  putSettings: (patch: UiSettings) => ipcRenderer.invoke('settings:put', patch),
  appInfo: () => ipcRenderer.invoke('app:info'),
  revealDb: () => ipcRenderer.invoke('app:revealDb'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  onSnapshot: (cb: (s: Snapshot) => void) => {
    const handler = (_e: unknown, s: Snapshot) => cb(s);
    ipcRenderer.on('snapshot', handler);
    return () => ipcRenderer.off('snapshot', handler);
  },
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => {
    const handler = (_e: unknown, s: UpdateStatus) => cb(s);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.off('update:status', handler);
  },
};

contextBridge.exposeInMainWorld('inquestry', api);
