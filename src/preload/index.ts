import { contextBridge, ipcRenderer } from 'electron';
import type {
  GateDecision,
  InquestryApi,
  IntakeDraft,
  OperatorReply,
  Snapshot,
  VerdictShape,
} from '../shared/ipc.js';

/** renderer 只能经这里够到 main —— contextIsolation 开、nodeIntegration 关。 */
const api: InquestryApi = {
  envCheck: () => ipcRenderer.invoke('env:check'),
  intakeOptions: () => ipcRenderer.invoke('intake:options'),
  pickProjectRoot: () => ipcRenderer.invoke('intake:pickRoot'),
  createCase: (draft: IntakeDraft) => ipcRenderer.invoke('case:create', draft),
  switchCase: (caseId: string) => ipcRenderer.invoke('case:switch', caseId),
  newCase: () => ipcRenderer.invoke('case:new'),
  start: (caseId: string, question?: string) => ipcRenderer.invoke('case:start', caseId, question),
  restart: (caseId: string) => ipcRenderer.invoke('case:restart', caseId),
  setTakeover: (caseId: string, on: boolean) => ipcRenderer.invoke('case:takeover', caseId, on),
  send: (caseId: string, text: string) => ipcRenderer.invoke('case:send', caseId, text),
  interrupt: (caseId: string) => ipcRenderer.invoke('case:interrupt', caseId),
  stopLane: (caseId: string, lane: string) => ipcRenderer.invoke('case:stopLane', caseId, lane),
  requestClosing: (caseId: string) => ipcRenderer.invoke('case:requestClosing', caseId),
  closeCase: (caseId: string, shape: VerdictShape) => ipcRenderer.invoke('case:close', caseId, shape),
  archiveCase: (caseId: string) => ipcRenderer.invoke('case:archive', caseId),
  answerOperator: (caseId: string, reply: OperatorReply) =>
    ipcRenderer.invoke('case:answerOperator', caseId, reply),
  decideGate: (caseId: string, d: GateDecision) => ipcRenderer.invoke('case:decideGate', caseId, d),
  exportMarkdown: (caseId: string) => ipcRenderer.invoke('case:exportMarkdown', caseId),
  exportImage: (caseId: string) => ipcRenderer.invoke('case:exportImage', caseId),
  exportPayload: (token: string) => ipcRenderer.invoke('export:payload', token),
  searchCases: (term: string) => ipcRenderer.invoke('case:search', term),
  snapshot: () => ipcRenderer.invoke('case:snapshot'),
  excerpt: (callId: string, anchor: string | null) => ipcRenderer.invoke('case:excerpt', callId, anchor),
  onSnapshot: (cb: (s: Snapshot) => void) => {
    const handler = (_e: unknown, s: Snapshot) => cb(s);
    ipcRenderer.on('snapshot', handler);
    return () => ipcRenderer.off('snapshot', handler);
  },
};

contextBridge.exposeInMainWorld('inquestry', api);
