const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const discord = require("./discord");

let core = null;
let corePort = null;
let coreToken = null;
let win = null;
let ytHost = null;

// Скрытому окну некому «нажать play» жестом мыши, поэтому снимаем это требование.
// Должно стоять до app.whenReady().
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/**
 * Наружу отдаём только http(s).
 *
 * Ссылку сюда приносит либо страница в скрытом окне YouTube — настоящий сайт со
 * своими редиректами и рекламой, — либо рендерер. Схему не проверив, мы передаём
 * системному обработчику что угодно: `file:` откроет проводник, а произвольный
 * протокол запустит зарегистрированное на него приложение с чужими аргументами.
 */
function openExternal(target) {
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.log(`[main] схема ${parsed.protocol} наружу не пойдёт: ${target}`);
    return;
  }
  shell.openExternal(parsed.toString());
}

/**
 * В dev ядро берём из target/, в собранном приложении — из resources/.
 * Отдельного конфига не заводим: два предсказуемых пути покрывают оба случая.
 */
function coreBinaryPath() {
  const packaged = path.join(process.resourcesPath || "", "mp-core.exe");
  if (fs.existsSync(packaged)) return packaged;

  const exe = process.platform === "win32" ? "mp-core.exe" : "mp-core";
  for (const profile of ["release", "debug"]) {
    const p = path.join(__dirname, "..", "core", "target", profile, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Поднимает Rust-ядро и ждёт, пока оно напечатает свой порт.
 * Порт выдаёт ОС, поэтому два запущенных экземпляра не подерутся.
 */
function startCore() {
  return new Promise((resolve, reject) => {
    const bin = coreBinaryPath();
    if (!bin) {
      return reject(
        new Error(
          "Не найден mp-core.exe. Соберите ядро:\n\n    cd core && cargo build --release"
        )
      );
    }

    core = spawn(bin, [], { windowsHide: true });

    const timer = setTimeout(
      () => reject(new Error("Ядро не ответило за 20 секунд")),
      20000
    );

    let buffer = "";
    core.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      // Ключ сессии ядро печатает здесь же — больше он нигде не появляется.
      const m = buffer.match(/MPCORE_READY (\d+) (\S+)/);
      if (m) {
        clearTimeout(timer);
        corePort = Number(m[1]);
        coreToken = m[2];
        resolve(corePort);
      }
    });

    core.stderr.on("data", (d) => process.stderr.write(`[core] ${d}`));
    core.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    core.on("exit", (code) => {
      if (corePort === null) {
        clearTimeout(timer);
        reject(new Error(`Ядро завершилось с кодом ${code}`));
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    // Своя рамка — иначе светлый системный заголовок ломает тёмный интерфейс.
    frame: false,
    backgroundColor: "#0b0b0c",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());

  // Скрытое окно плеера само по себе не закроется и удержит приложение живым.
  win.on("closed", () => {
    app.isQuitting = true;
    if (ytHost && !ytHost.isDestroyed()) ytHost.destroy();
  });

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  // Внешние ссылки — в системный браузер, а не новым окном Electron.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
}

/**
 * Скрытое окно с настоящим music.youtube.com — «звуковая карта» для треков ytmusic.
 *
 * Почему именно так. Прямых ссылок на аудио YouTube анонимным клиентам не даёт
 * (нужен PO-токен), а встраиваемый IFrame-плеер отвергает localhost как origin —
 * и то и другое проверено. Зато сам сайт работает: origin настоящий, токенами
 * занимается его собственный плеер, вход в аккаунт не нужен.
 *
 * Управляем обычным <video> на странице — это и есть публичный интерфейс браузера.
 */
function createYtHost() {
  ytHost = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    title: "YouTube Music",
    backgroundColor: "#0b0b0c",
    webPreferences: {
      // Своя сессия: согласие и настройки YouTube хранятся отдельно от остального
      // приложения и не смешиваются с браузером пользователя.
      partition: "persist:ytmusic",
      contextIsolation: true,
      nodeIntegration: false,
      // Без этого Chromium душит таймеры в фоновом окне и звук начинает заикаться.
      backgroundThrottling: false,
    },
  });

  ytHost.loadURL("https://music.youtube.com/");

  // Закрывать окно нельзя — без него не играет YouTube. Прячем.
  ytHost.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      ytHost.hide();
    }
  });

  ytHost.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  // YouTube иногда требует вмешательства — согласие с условиями, капча.
  // Молча провалить воспроизведение нельзя, поэтому показываем окно.
  ytHost.webContents.on("did-navigate", (_e, url) => {
    if (/consent\.|\/sorry\//.test(url)) {
      ytHost.show();
      send(win, "yt:event", {
        type: "needs-attention",
        message: "YouTube просит подтвердить условия — сделайте это в открывшемся окне",
      });
    }
  });
}

const send = (target, channel, payload) => {
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
};

/** Читает состояние <video> прямо со страницы: у неё нет другого API. */
const READ_STATE = `(() => {
  const v = document.querySelector("video");
  if (!v) return null;
  return { position: v.currentTime || 0, duration: v.duration || 0, paused: v.paused, ended: v.ended };
})()`;

let ytPoll = null;

function startYtPolling() {
  if (ytPoll) return;
  ytPoll = setInterval(async () => {
    if (!ytHost || ytHost.isDestroyed()) return;
    try {
      const s = await ytHost.webContents.executeJavaScript(READ_STATE, true);
      if (!s) return;
      if (s.ended) send(win, "yt:event", { type: "ended" });
      else
        send(win, "yt:event", {
          type: "time",
          position: s.position,
          duration: s.duration,
          playing: !s.paused,
        });
    } catch {
      // Страница в этот момент перезагружается — следующий тик всё равно придёт.
    }
  }, 300);
}

app.whenReady().then(async () => {
  try {
    await startCore();
  } catch (e) {
    dialog.showErrorBox("Не удалось запустить ядро", e.message);
    app.quit();
    return;
  }
  createWindow();
  createYtHost();
  // Ждать Discord не нужно: модуль сам подключится, когда клиент появится.
  discord.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

// Окно YouTube отказывается закрываться, пока приложение живо, — снимаем защиту.
app.on("before-quit", () => {
  app.isQuitting = true;
});

// Ядро — дочерний процесс; без явного kill оно переживёт окно и займёт память.
app.on("will-quit", () => {
  clearInterval(ytPoll);
  discord.stop();
  if (core && !core.killed) core.kill();
});

ipcMain.handle("core:port", () => ({ port: corePort, token: coreToken }));

// Присутствие — дело необязательное: молча глотаем всё, что пойдёт не так.
ipcMain.handle("discord:track", (_e, info) => {
  try {
    discord.setTrack(info);
  } catch {}
});

// --- управление скрытой вкладкой YouTube Music -------------------------------

async function ytExec(js) {
  if (!ytHost || ytHost.isDestroyed()) return null;
  try {
    return await ytHost.webContents.executeJavaScript(js, true);
  } catch {
    return null;
  }
}

/** Плеер появляется не сразу после загрузки страницы, поэтому ждём его. */
const WAIT_AND_PLAY = `new Promise((resolve) => {
  let tries = 0;
  const t = setInterval(() => {
    const v = document.querySelector("video");
    if (v) {
      clearInterval(t);
      v.play().then(() => resolve("ok"), (e) => resolve("blocked: " + e.message));
    } else if (++tries > 80) {
      clearInterval(t);
      resolve("no-video");
    }
  }, 250);
})`;

let ytVolume = 0.8;

ipcMain.handle("yt:cmd", async (_e, { action, value }) => {
  if (!ytHost || ytHost.isDestroyed()) return;

  switch (action) {
    case "load": {
      await ytHost.loadURL(`https://music.youtube.com/watch?v=${encodeURIComponent(value)}`);
      startYtPolling();
      const res = await ytExec(WAIT_AND_PLAY);
      await ytExec(`{ const v = document.querySelector("video"); if (v) v.volume = ${ytVolume}; }`);
      if (res !== "ok") {
        send(win, "yt:event", {
          type: "error",
          message:
            res === "no-video"
              ? "YouTube не отдал плеер — возможно, нужно подтвердить условия"
              : "браузер не дал начать воспроизведение",
        });
      }
      break;
    }
    case "play":
      await ytExec(`document.querySelector("video")?.play()`);
      break;
    case "pause":
      await ytExec(`document.querySelector("video")?.pause()`);
      break;
    case "stop":
      await ytExec(`{ const v = document.querySelector("video"); if (v) { v.pause(); v.currentTime = 0; } }`);
      break;
    case "seek":
      await ytExec(`{ const v = document.querySelector("video"); if (v) v.currentTime = ${Number(value) || 0}; }`);
      break;
    case "volume":
      ytVolume = Number(value) || 0;
      await ytExec(`{ const v = document.querySelector("video"); if (v) v.volume = ${ytVolume}; }`);
      break;
    case "show":
      ytHost.show();
      break;
  }
});

ipcMain.handle("window:action", (_e, action) => {
  if (!win) return;
  if (action === "minimize") win.minimize();
  if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === "close") win.close();
});

ipcMain.handle("dialog:pickFolder", async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "multiSelections"],
    title: "Выберите папки с музыкой",
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("shell:openExternal", (_e, url) => openExternal(url));
