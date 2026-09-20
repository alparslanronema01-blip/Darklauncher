'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darklauncher', {
  // window
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // versions
  listVersions: (includeSnapshots) => ipcRenderer.invoke('versions:list', includeSnapshots),
  installedVersions: () => ipcRenderer.invoke('versions:installed'),
  installedDetailed: () => ipcRenderer.invoke('versions:detailed'),
  deleteVersion: (id) => ipcRenderer.invoke('versions:delete', id),

  // fabric
  installFabric: (gameVersion, loaderVersion) => ipcRenderer.invoke('fabric:install', { gameVersion, loaderVersion }),

  // mods (Modrinth)
  searchMods: (query, gameVersion, opts) => ipcRenderer.invoke('mods:search', Object.assign({ query, gameVersion }, opts)),
  topMods: (gameVersion, limit, offset) => ipcRenderer.invoke('mods:top', { gameVersion, limit, offset }),
  cfStatus: () => ipcRenderer.invoke('cf:status'),
  cfSearchMods: (query, gameVersion, offset) => ipcRenderer.invoke('cf:searchMods', { query, gameVersion, offset }),
  cfTopMods: (gameVersion, offset) => ipcRenderer.invoke('cf:topMods', { gameVersion, offset }),
  cfInstallMod: (projectId, gameVersion, fabricId) => ipcRenderer.invoke('cf:installMod', { projectId, gameVersion, fabricId }),
  searchShaders: (query, limit, source, offset) => ipcRenderer.invoke('shaders:search', { query, limit, source, offset }),
  topShaders: (limit, source, offset) => ipcRenderer.invoke('shaders:top', { limit, source, offset }),
  listShaders: () => ipcRenderer.invoke('shaders:list'),
  installShader: (slug, source) => ipcRenderer.invoke('shaders:install', { slug, source }),
  removeShader: (name) => ipcRenderer.invoke('shaders:remove', name),
  installMod: (slug, gameVersion, fabricId) => ipcRenderer.invoke('mods:install', { slug, gameVersion, fabricId }),
  listMods: (fabricId) => ipcRenderer.invoke('mods:list', fabricId),
  removeMod: (fabricId, name) => ipcRenderer.invoke('mods:remove', { fabricId, name }),

  // servers
  listServers: () => ipcRenderer.invoke('servers:list'),
  addServer: (server) => ipcRenderer.invoke('servers:add', server),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),

  // auth
  activeAccount: () => ipcRenderer.invoke('auth:active'),
  listAccounts: () => ipcRenderer.invoke('auth:accounts'),
  switchAccount: (uuid) => ipcRenderer.invoke('auth:switch', uuid),
  signout: () => ipcRenderer.invoke('auth:signout'),
  loginOffline: (name) => ipcRenderer.invoke('auth:offline', name),
  msaStart: () => ipcRenderer.invoke('auth:msa:start'),
  msaPoll: () => ipcRenderer.invoke('auth:msa:poll'),

  // game
  launch: (payload) => ipcRenderer.invoke('game:launch', payload),
  stopGame: () => ipcRenderer.invoke('game:stop'),
  isRunning: () => ipcRenderer.invoke('game:isRunning'),
  openGameFolder: () => ipcRenderer.invoke('app:openGameFolder'),

  // app info & diagnostics
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  // backgrounds (animated themes + user images)
  bgChooseImage: () => ipcRenderer.invoke('bg:chooseImage'),
  bgList: () => ipcRenderer.invoke('bg:list'),
  bgDelete: (name) => ipcRenderer.invoke('bg:delete', name),
  bgLoad: (name) => ipcRenderer.invoke('bg:load', name),

  // events
  onLog: (cb) => ipcRenderer.on('game:log', (_e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('game:progress', (_e, p) => cb(p)),
  onState: (cb) => ipcRenderer.on('game:state', (_e, s) => cb(s)),
  onWindow: (cb) => ipcRenderer.on('window', (_e, s) => cb(s))
});
