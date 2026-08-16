const { contextBridge, ipcRenderer } = require("electron");

// Единственный мост в main-процесс. Ничего сверх этого списка рендереру не нужно,
// поэтому nodeIntegration выключен, а contextIsolation включён.
contextBridge.exposeInMainWorld("desktop", {
  corePort: () => ipcRenderer.invoke("core:port"),
  window: (action) => ipcRenderer.invoke("window:action", action),
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // Rich Presence: рендерер отдаёт снимок состояния, остальное — в main.
  discord: {
    setTrack: (info) => ipcRenderer.invoke("discord:track", info),
  },

  // Управление скрытым окном с IFrame-плеером YouTube.
  yt: {
    cmd: (action, value) => ipcRenderer.invoke("yt:cmd", { action, value }),
    onEvent: (cb) => ipcRenderer.on("yt:event", (_e, data) => cb(data)),
  },
});
