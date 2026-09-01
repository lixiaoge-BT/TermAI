var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/preload/index.ts
var preload_exports = {};
module.exports = __toCommonJS(preload_exports);
var import_electron = require("electron");
var sshApi = {
  connect: (sessionId, params) => import_electron.ipcRenderer.invoke("ssh:connect", params, sessionId),
  disconnect: (sessionId) => import_electron.ipcRenderer.invoke("ssh:disconnect", sessionId),
  write: (sessionId, data) => import_electron.ipcRenderer.invoke("ssh:write", sessionId, data),
  resize: (sessionId, cols, rows) => import_electron.ipcRenderer.invoke("ssh:resize", sessionId, cols, rows),
  listSessions: () => import_electron.ipcRenderer.invoke("ssh:list-sessions"),
  onData: (callback) => {
    const listener = (_e, sessionId, data) => callback(sessionId, data);
    import_electron.ipcRenderer.on("ssh:data", listener);
    return () => import_electron.ipcRenderer.off("ssh:data", listener);
  },
  onStatus: (callback) => {
    const listener = (_e, sessionId, status, extra) => callback(sessionId, status, extra);
    import_electron.ipcRenderer.on("ssh:status", listener);
    return () => import_electron.ipcRenderer.off("ssh:status", listener);
  }
};
var winApi = {
  openNewWindow: () => import_electron.ipcRenderer.invoke("win:open-new-window")
};
var localTerminalApi = {
  create: (sessionId, shell) => import_electron.ipcRenderer.invoke("local-terminal:create", sessionId, shell),
  write: (sessionId, data) => import_electron.ipcRenderer.invoke("local-terminal:write", sessionId, data),
  resize: (sessionId, cols, rows) => import_electron.ipcRenderer.invoke("local-terminal:resize", sessionId, cols, rows),
  dispose: (sessionId) => import_electron.ipcRenderer.invoke("local-terminal:dispose", sessionId),
  onData: (callback) => {
    const listener = (_e, sessionId, data) => callback(sessionId, data);
    import_electron.ipcRenderer.on("local-terminal:data", listener);
    return () => import_electron.ipcRenderer.off("local-terminal:data", listener);
  },
  onReady: (callback) => {
    const listener = (_e, sessionId) => callback(sessionId);
    import_electron.ipcRenderer.on("local-terminal:ready", listener);
    return () => import_electron.ipcRenderer.off("local-terminal:ready", listener);
  },
  onExit: (callback) => {
    const listener = (_e, sessionId, exitCode) => callback(sessionId, exitCode);
    import_electron.ipcRenderer.on("local-terminal:exit", listener);
    return () => import_electron.ipcRenderer.off("local-terminal:exit", listener);
  },
  onError: (callback) => {
    const listener = (_e, sessionId, error) => callback(sessionId, error);
    import_electron.ipcRenderer.on("local-terminal:error", listener);
    return () => import_electron.ipcRenderer.off("local-terminal:error", listener);
  }
};
var clipboardApi = {
  writeText: (text) => import_electron.clipboard.writeText(text),
  readText: () => import_electron.clipboard.readText()
};
import_electron.contextBridge.exposeInMainWorld("ssh", sshApi);
import_electron.contextBridge.exposeInMainWorld("termAI", winApi);
import_electron.contextBridge.exposeInMainWorld("localTerminal", localTerminalApi);
import_electron.contextBridge.exposeInMainWorld("clipboard", clipboardApi);
import_electron.contextBridge.exposeInMainWorld("__termai_debug", {
  ping: () => import_electron.ipcRenderer.invoke("ping", "hello from renderer")
});
