import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { GstManager } from './torrserver/manager';

let mainWindow: BrowserWindow | null = null;
let gstManager: GstManager | null = null;
let quittingAfterGstStop = false;
let gstAutostart = true;
const gstSettingsPath = () => join(app.getPath('userData'), 'torrserver-gst-settings.json');

async function loadGstAutostart(): Promise<boolean> {
    try {
        const data = JSON.parse(await readFile(gstSettingsPath(), 'utf8'));
        return data.autostart !== false;
    } catch {
        return true;
    }
}

async function saveGstAutostart(value: boolean): Promise<void> {
    gstAutostart = value;
    await writeFile(gstSettingsPath(), JSON.stringify({ autostart: value }, null, 2), 'utf8');
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const raw = event.senderFrame?.url || '';
    try {
        const url = new URL(raw);
        return app.isPackaged
            ? url.protocol === 'file:' && url.pathname.endsWith('/build/web/index.html')
            : url.protocol === 'http:' && (url.origin === 'http://localhost:3000' || url.origin === 'http://127.0.0.1:3000');
    } catch {
        return false;
    }
}

function requireTrustedSender(event: IpcMainInvokeEvent): GstManager {
    if (!isTrustedSender(event)) throw new Error('Blocked IPC from untrusted renderer.');
    if (!gstManager) throw new Error('GST manager is not ready yet.');
    return gstManager;
}

function registerExternalPlayerIpc(): void {
    const trusted = (event: IpcMainInvokeEvent) => isTrustedSender(event);
    ipcMain.handle('external-player:exists', (event, path: unknown) => {
        if (!trusted(event)) throw new Error('Blocked IPC from untrusted renderer.');
        if (typeof path !== 'string' || !path.trim()) return false;
        return existsSync(path);
    });
    ipcMain.handle('external-player:launch', (event, path: unknown, args: unknown) => {
        if (!trusted(event)) throw new Error('Blocked IPC from untrusted renderer.');
        if (typeof path !== 'string' || !path.trim() || !Array.isArray(args) || !args.every(a => typeof a === 'string'))
            throw new Error('Invalid external player launch arguments.');
        if (!existsSync(path)) return { launched: false };
        const child = spawn(path, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', error => console.error('[External Player]', error));
        child.unref();
        return { launched: true, pid: child.pid };
    });
}


function registerGstIpc(): void {
    ipcMain.handle('torrserver-gst:status', (event) => requireTrustedSender(event).status());
    ipcMain.handle('torrserver-gst:latest', (event) => requireTrustedSender(event).findLatest());
    ipcMain.handle('torrserver-gst:install', (event) => {
        const manager = requireTrustedSender(event);
        if (process.platform !== 'win32' || process.arch !== 'x64') {
            throw new Error('Managed GST binary installation is currently supported on Windows x64 only.');
        }
        return manager.installLatest();
    });
    ipcMain.handle('torrserver-gst:start', (event) => requireTrustedSender(event).start());
    ipcMain.handle('torrserver-gst:stop', (event) => requireTrustedSender(event).stop());
    ipcMain.handle('torrserver-gst:set-autostart', async (event, value: unknown) => {
        requireTrustedSender(event);
        if (typeof value !== 'boolean') throw new Error('Invalid GST autostart value.');
        await saveGstAutostart(value);
        return gstAutostart;
    });
}


function setupAutoUpdates(): void {
    if (!app.isPackaged || process.platform !== 'win32') return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', async (info) => {
        const choice = await dialog.showMessageBox(mainWindow!, {
            type: 'info', buttons: ['Download update', 'Later'], defaultId: 0, cancelId: 1,
            title: 'Lampa update available',
            message: 'A new Lampa version (' + info.version + ') is available. Download it now?'
        });
        if (choice.response === 0) autoUpdater.downloadUpdate();
    });
    autoUpdater.on('update-downloaded', async (info) => {
        const choice = await dialog.showMessageBox(mainWindow!, {
            type: 'info', buttons: ['Restart and install', 'Later'], defaultId: 0, cancelId: 1,
            title: 'Lampa update ready',
            message: 'Lampa ' + info.version + ' has been downloaded. Restart to install it?'
        });
        if (choice.response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', (error) => console.error('[Auto Update]', error));
    setTimeout(() => autoUpdater.checkForUpdates().catch(error => console.error('[Auto Update] Check failed:', error)), 15000);
}

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        autoHideMenuBar: true,
        backgroundColor: '#242424',
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#00000000',
            symbolColor: '#ffffff'
        },
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        const devToolsShortcut = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
        if (devToolsShortcut) {
            event.preventDefault();
            mainWindow?.webContents.openDevTools({ mode: 'detach' });
        }
    });

    if (app.isPackaged) {
        mainWindow.loadFile(join(app.getAppPath(), 'build', 'web', 'index.html'));
    } else {
        mainWindow.loadURL('http://localhost:3000');
    }
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    gstManager = new GstManager(app.getPath('userData'));
    registerGstIpc();
    registerExternalPlayerIpc();
    gstAutostart = await loadGstAutostart();

    // Launch managed GST before the Lampa renderer starts initializing.
    if (gstAutostart && process.platform === 'win32' && process.arch === 'x64') {
        try {
            const status = await gstManager.status();
            if (status.installed && !status.running) await gstManager.start();
        } catch (error) {
            console.error('[TorrServer GST] Startup failed:', error);
        }
    }

    createWindow();
    setupAutoUpdates();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('before-quit', (event) => {
    if (quittingAfterGstStop || !gstManager) return;
    event.preventDefault();
    void gstManager.stop().finally(() => {
        quittingAfterGstStop = true;
        app.quit();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
