/**
 * Rich Presence — строка «слушает …» в профиле Discord.
 *
 * Сетевого API у присутствия нет: клиент Discord на этой же машине слушает
 * именованный пайп \\?\pipe\discord-ipc-N, и весь протокол — кадры вида
 * [опкод u32 LE][длина u32 LE][JSON]. Готовую библиотеку не берём: discord-rpc
 * в npm заброшен, а здесь сотня строк и ноль зависимостей — как и во всём проекте.
 *
 * Модуль намеренно молчаливый. Discord может быть не запущен, закрыт посреди
 * сессии или запущен позже плеера — ни один из этих случаев не должен доходить
 * до пользователя, поэтому наружу не летит ни одной ошибки.
 */

const net = require("net");
const path = require("path");
const os = require("os");

/**
 * Присутствие всегда привязано к приложению в Discord: имя над статусом и ключи
 * картинок берутся оттуда, из портала разработчика. Без идентификатора показывать
 * нечего, поэтому при пустом значении модуль просто выключается.
 *
 * Переменной окружения OVERTONE_DISCORD_APP_ID можно подставить другое приложение,
 * не пересобирая сборку.
 */
const CLIENT_ID = process.env.OVERTONE_DISCORD_APP_ID || "1538408751680323594";

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// Discord режет частые обновления присутствия (порядка пяти за двадцать секунд).
// Три секунды — с запасом, а треки и так не переключаются чаще.
const MIN_INTERVAL_MS = 3000;
const RETRY_MS = 15000;

let sock = null;
let ready = false;
let closed = false;
let retryTimer = null;
let sendTimer = null;
let lastSentAt = 0;

let desired = null; // что хотим показывать (null — ничего)
let sentJson = null; // что уже ушло, чтобы не слать одно и то же

function pipePath(id) {
  if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${id}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir();
  return path.join(base, `discord-ipc-${id}`);
}

function write(op, payload) {
  if (!sock || sock.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  try {
    sock.write(Buffer.concat([head, body]));
  } catch {
    // Пайп закрылся между проверкой и записью — переподключимся по событию close.
  }
}

function flush() {
  if (!ready || closed) return;

  const json = JSON.stringify(desired);
  if (json === sentJson) return;

  const wait = MIN_INTERVAL_MS - (Date.now() - lastSentAt);
  if (wait > 0) {
    // Копим до конца паузы: важно последнее состояние, промежуточные не нужны.
    if (!sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = null;
        flush();
      }, wait);
    }
    return;
  }

  sentJson = json;
  lastSentAt = Date.now();
  write(OP.FRAME, {
    cmd: "SET_ACTIVITY",
    nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    args: { pid: process.pid, activity: desired },
  });
}

function handleFrame(op, body) {
  let msg = null;
  try {
    msg = JSON.parse(body);
  } catch {
    return;
  }

  if (op === OP.PING) return write(OP.PONG, msg);

  // Клиент прощается сам. Неверный идентификатор приложения — не временный сбой,
  // а опечатка в настройке: переподключение будет повторять её каждые 15 секунд.
  if (op === OP.CLOSE) {
    if (msg.code === 4000) {
      closed = true;
      console.log(`[discord] неверный Application ID — Rich Presence выключен (${CLIENT_ID})`);
    }
    return;
  }

  if (op !== OP.FRAME) return;

  // До READY команды принимать никто не обязан.
  if (msg.cmd === "DISPATCH" && msg.evt === "READY") {
    ready = true;
    flush();
  }
}

function bind(s) {
  let buf = Buffer.alloc(0);

  s.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Кадр может прийти по частям и несколько штук за раз — разбираем сколько есть.
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0);
      const len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      handleFrame(op, buf.subarray(8, 8 + len).toString("utf8"));
      buf = buf.subarray(8 + len);
    }
  });

  s.on("close", () => {
    sock = null;
    ready = false;
    sentJson = null;
    clearTimeout(sendTimer);
    sendTimer = null;
    scheduleRetry();
  });
}

/** Пайпов десять: несколько клиентов Discord (стабильный, PTB, Canary) живут рядом. */
function connect(id = 0) {
  if (closed || sock || !CLIENT_ID) return;
  if (id > 9) return scheduleRetry();

  const s = net.createConnection(pipePath(id));

  s.once("error", () => {
    s.destroy();
    connect(id + 1);
  });

  s.once("connect", () => {
    sock = s;
    // Дальше ошибки означают «клиент закрылся»; их обрабатывает close,
    // но слушатель нужен — иначе 'error' повалит процесс.
    s.removeAllListeners("error");
    s.on("error", () => {});
    bind(s);
    write(OP.HANDSHAKE, { v: 1, client_id: CLIENT_ID });
  });
}

function scheduleRetry() {
  if (closed || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect(0);
  }, RETRY_MS);
}

// Discord отвергает строки короче двух символов и обрезает всё длиннее 128.
function fit(value, fallback) {
  const v = String(value || "").trim();
  if (v.length < 2) return fallback;
  return v.length > 128 ? v.slice(0, 127) + "…" : v;
}

/**
 * @param {null|{title,artist,album,artwork,position,duration,playing}} t
 *   null — убрать статус.
 */
function setTrack(t) {
  if (!CLIENT_ID) return;

  if (!t) {
    desired = null;
    return flush();
  }

  const activity = {
    type: 2, // LISTENING: «слушает Overtone», а не «играет в Overtone»
    details: fit(t.title, "Без названия"),
    state: fit(t.artist, "Неизвестный исполнитель"),
    instance: false,
  };

  // Полосу прогресса Discord двигает сам между двумя метками времени. На паузе
  // её надо убрать целиком, иначе она продолжит ехать под остановленную музыку.
  if (t.playing && t.duration > 0) {
    const now = Date.now();
    activity.timestamps = {
      start: Math.round(now - t.position * 1000),
      end: Math.round(now + (t.duration - t.position) * 1000),
    };
  }

  // Обложку Discord забирает со своей стороны, поэтому годятся только публичные
  // адреса: локальные файлы отдаются с 127.0.0.1 и ему недоступны. Для них
  // остаётся ключ ассета, загруженного в портале разработчика.
  const art = typeof t.artwork === "string" && t.artwork.startsWith("https://") ? t.artwork : null;
  activity.assets = {
    large_image: art || "cover",
    large_text: fit(t.album || t.title, "Overtone"),
    small_image: t.playing ? "play" : "pause",
    small_text: t.playing ? "Играет" : "Пауза",
  };

  desired = activity;
  flush();
}

function start() {
  if (!CLIENT_ID) {
    console.log("[discord] OVERTONE_DISCORD_APP_ID не задан — Rich Presence выключен");
    return;
  }
  connect(0);
}

function stop() {
  closed = true;
  clearTimeout(retryTimer);
  clearTimeout(sendTimer);
  // Статус снимается сам, когда пайп закрывается: отдельный SET_ACTIVITY с null
  // уже не успеет уйти на выходе из приложения.
  if (sock && !sock.destroyed) sock.destroy();
  sock = null;
}

module.exports = { start, stop, setTrack, enabled: () => Boolean(CLIENT_ID) };
