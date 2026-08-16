"use strict";

/* ---------------------------------------------------------------------------
   Состояние. Одно место истины; любая мутация проходит через render().
   --------------------------------------------------------------------------- */
const state = {
  base: null, // http://127.0.0.1:PORT
  view: { name: "search" },
  providers: [],
  enabled: new Set(), // активные фильтры источников
  query: "",
  results: [],
  searchErrors: [],
  searching: false,
  library: { liked: [], playlists: [], local_roots: [] },
  localTracks: [],
  queue: [],
  index: -1,
  playing: false,
  shuffle: false,
  repeat: "off", // off | all | one
  history: [], // для «назад» при включённом шаффле
  engine: null, // движок, который играет прямо сейчас
  position: 0,
  duration: 0,
  volume: 0.8,
};

const $ = (sel) => document.querySelector(sel);
const audio = $("#audio");
const content = $("#content");

/**
 * Любой адрес ядра несёт ключ сессии — без него API отвечает 401.
 * Именно в адресе, а не в заголовке: `<audio src>` и `<img src>` заголовков не ставят.
 */
const url = (path) =>
  `${state.base}${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(state.token)}`;

const api = (path, opts) => fetch(url(path), opts);

/**
 * Адрес обложки приходит от провайдера, то есть снаружи. Без экранирования
 * кавычка в нём закрывает `url(` и дописывает в inline-стиль произвольные
 * CSS-свойства. В строке CSS достаточно защитить кавычку и обратный слеш.
 */
const cssUrl = (u) => `url("${u.replace(/[\\"]/g, "\\$&")}")`;

/* --- Утилиты ------------------------------------------------------------- */
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const uid = (t) => `${t.provider}:${t.id}`;

/** Локальные обложки приходят относительным путём — их отдаёт то же ядро. */
function artUrl(track) {
  if (!track.artwork) return null;
  return track.artwork.startsWith("/") ? url(track.artwork) : track.artwork;
}

let toastTimer = null;
function toast(msg, ms = 3400) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* --- Загрузка ------------------------------------------------------------ */
/**
 * Вне Electron (открыли renderer прямо в браузере для отладки вёрстки) моста
 * в main-процесс нет — подставляем заглушку и берём порт из ?port=…
 */
const bridge = (function () {
  if (typeof desktop !== "undefined") return desktop;
  if (typeof window !== "undefined" && window.desktop) return window.desktop;
  const noop = async () => {};
  return {
    corePort: async () => {
      const p = new URLSearchParams(location.search);
      return { port: p.get("port"), token: p.get("token") };
    },
    window: noop,
    pickFolder: async () => [],
    openExternal: noop,
    discord: { setTrack: noop },
    yt: {
      cmd: noop,
      onEvent: () => {},
    },
  };
})();

async function boot() {
  const { port, token } = await bridge.corePort();
  state.base = `http://127.0.0.1:${port}`;
  state.token = token;

  try {
    const health = await api("/api/health").then((r) => r.json());
    $("#core-dot").setAttribute("data-ok", "");
    $("#core-status").textContent = `ядро ${health.version}`;

    state.providers = await api("/api/providers").then((r) => r.json());
    state.enabled = new Set(state.providers.map((p) => p.id));
    state.library = await api("/api/library").then((r) => r.json());
  } catch (e) {
    $("#core-dot").setAttribute("data-bad", "");
    $("#core-status").textContent = "ядро недоступно";
    toast("Не удалось связаться с ядром: " + e.message, 8000);
  }

  state.volume = Number(localStorage.getItem("volume") ?? 0.8);
  audio.volume = state.volume;
  $("#vol-fill").style.width = state.volume * 100 + "%";

  bindChrome();
  renderSidebar();
  render();
}

async function saveLibrary() {
  await api("/api/library", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.library),
  });
  renderSidebar();
}

/* ---------------------------------------------------------------------------
   Представления
   --------------------------------------------------------------------------- */
function render() {
  document
    .querySelectorAll(".nav")
    .forEach((b) => b.toggleAttribute("data-active", b.dataset.view === state.view.name));
  document
    .querySelectorAll(".pl")
    .forEach((b) =>
      b.toggleAttribute(
        "data-active",
        state.view.name === "playlist" && b.dataset.id === state.view.id
      )
    );

  content.replaceChildren();
  const views = {
    search: viewSearch,
    liked: viewLiked,
    local: viewLocal,
    playlist: viewPlaylist,
    settings: viewSettings,
  };
  (views[state.view.name] || viewSearch)();
}

function viewSearch() {
  const bar = el("div", "searchbar");
  bar.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L21 21"/></svg>';
  const input = el("input");
  input.type = "search";
  input.placeholder = "Трек, исполнитель, альбом…";
  input.value = state.query;
  input.autofocus = true;
  bar.append(input);

  const filters = el("div", "filters");
  for (const p of state.providers) {
    const chip = el("button", "chip", p.label);
    chip.toggleAttribute("data-on", state.enabled.has(p.id));
    chip.onclick = () => {
      // Последний включённый фильтр не даём выключить: пустой набор источников
      // означал бы гарантированно пустую выдачу.
      if (state.enabled.has(p.id) && state.enabled.size > 1) state.enabled.delete(p.id);
      else state.enabled.add(p.id);
      render();
      if (state.query) runSearch(state.query);
    };
    filters.append(chip);
  }

  content.append(bar, filters);

  for (const err of state.searchErrors) {
    const label = state.providers.find((p) => p.id === err.provider)?.label || err.provider;
    content.append(el("div", "notice", `${label}: ${err.message}`));
  }

  if (state.searching) {
    content.append(emptyBlock("Ищем…", ""));
  } else if (!state.query) {
    content.append(
      emptyBlock("Поиск по всем источникам сразу", "YouTube Music, SoundCloud и ваши файлы")
    );
  } else if (!state.results.length) {
    content.append(emptyBlock("Ничего не нашлось", `по запросу «${state.query}»`));
  } else {
    content.append(trackList(state.results, { showSource: true }));
  }

  let timer = null;
  input.addEventListener("input", () => {
    state.query = input.value;
    clearTimeout(timer);
    // Дебаунс: без него каждая буква уходит в сеть, а Innertube это не любит.
    timer = setTimeout(() => runSearch(input.value), 350);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      runSearch(input.value);
    }
  });

  queueMicrotask(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function viewLiked() {
  content.append(el("h1", "page-title", "Любимое"));
  if (!state.library.liked.length) {
    content.append(emptyBlock("Пока пусто", "Нажмите ♥ на треке, чтобы он появился здесь"));
    return;
  }
  content.append(trackList(state.library.liked, { showSource: true }));
}

function viewPlaylist() {
  const pl = state.library.playlists.find((p) => p.id === state.view.id);
  if (!pl) {
    state.view = { name: "search" };
    return render();
  }

  const head = el("div");
  head.style.cssText = "display:flex;align-items:center;gap:14px;margin-bottom:18px";
  const title = el("h1", "page-title", pl.name);
  title.style.margin = "0";

  const rename = el("button", "btn", "Переименовать");
  rename.onclick = () => {
    const name = prompt("Название плейлиста", pl.name);
    if (name && name.trim()) {
      pl.name = name.trim();
      saveLibrary();
      render();
    }
  };
  const remove = el("button", "btn", "Удалить");
  remove.onclick = () => {
    if (!confirm(`Удалить плейлист «${pl.name}»?`)) return;
    state.library.playlists = state.library.playlists.filter((p) => p.id !== pl.id);
    state.view = { name: "search" };
    saveLibrary();
    render();
  };

  head.append(title, rename, remove);
  content.append(head);

  if (!pl.tracks.length) {
    content.append(emptyBlock("Плейлист пуст", "Добавьте треки через меню «…» справа от трека"));
    return;
  }
  content.append(trackList(pl.tracks, { showSource: true, playlistId: pl.id }));
}

function viewLocal() {
  content.append(el("h1", "page-title", "Мои файлы"));

  const roots = el("div", "roots");
  if (!state.library.local_roots.length) {
    roots.append(el("div", "notice", "Папки не добавлены — плеер пока не знает, где искать музыку."));
  }
  for (const r of state.library.local_roots) {
    const row = el("div", "root");
    row.append(el("span", null, r));
    const del = el("button", null, "Убрать");
    del.onclick = async () => {
      state.library.local_roots = state.library.local_roots.filter((x) => x !== r);
      await saveLibrary();
      await loadLocal();
      render();
    };
    row.append(del);
    roots.append(row);
  }
  content.append(roots);

  const actions = el("div");
  actions.style.cssText = "display:flex;gap:10px;margin-bottom:24px";

  const add = el("button", "btn btn--primary", "Добавить папку");
  add.onclick = async () => {
    const picked = await bridge.pickFolder();
    if (!picked.length) return;
    const set = new Set([...state.library.local_roots, ...picked]);
    state.library.local_roots = [...set];
    await saveLibrary();
    await loadLocal();
    render();
    toast(`Найдено треков: ${state.localTracks.length}`);
  };

  const rescan = el("button", "btn", "Пересканировать");
  rescan.onclick = async () => {
    rescan.textContent = "Сканирую…";
    const res = await api("/api/library/scan", { method: "POST" }).then((r) => r.json());
    await loadLocal();
    render();
    toast(`Найдено треков: ${res.count}`);
  };

  actions.append(add, rescan);
  content.append(actions);

  if (state.localTracks.length) {
    content.append(trackList(state.localTracks, { showSource: false }));
  }
}

function viewSettings() {
  content.append(el("h1", "page-title", "Настройки"));

  const section = (title) => {
    const h = el("div", null, title);
    h.style.cssText =
      "font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:22px 0 10px";
    return h;
  };

  const para = (text) => {
    const p = el("div", null, text);
    p.style.cssText = "color:var(--muted);font-size:13px;max-width:640px;margin-bottom:10px";
    return p;
  };

  content.append(section("Как играют источники"));
  content.append(
    para(
      "SoundCloud и локальные файлы идут потоком через ядро — обычный звук, " +
        "с перемоткой и без посредников."
    )
  );
  content.append(
    para(
      "YouTube Music играет в скрытом окне с настоящим сайтом music.youtube.com. " +
        "Ни cookies вашего браузера, ни вход в аккаунт, ни сторонние утилиты для этого не нужны: " +
        "сайт открыт в собственной сессии приложения и сам разбирается с токенами."
    )
  );
  content.append(
    para(
      "Изредка YouTube просит подтвердить условия или пройти проверку — тогда окно " +
        "показывается само. Его можно открыть и вручную."
    )
  );

  const showBtn = el("button", "btn", "Показать окно YouTube");
  showBtn.onclick = () => bridge.yt.cmd("show");
  content.append(showBtn);

  content.append(section("Данные"));
  const where = el("div");
  where.style.cssText = "color:var(--muted);font-size:13px";
  where.textContent =
    "Плейлисты, любимое и настройки хранятся в %APPDATA%\\Overtone\\library.json";
  content.append(where);
}

async function loadLocal() {
  try {
    state.localTracks = await api("/api/library/tracks").then((r) => r.json());
  } catch {
    state.localTracks = [];
  }
}

function emptyBlock(title, sub) {
  const box = el("div", "empty");
  box.append(el("h3", null, title));
  if (sub) box.append(el("div", null, sub));
  return box;
}

/* --- Список треков ------------------------------------------------------- */
function trackList(tracks, opts = {}) {
  const wrap = el("div", "rows");
  const current = state.queue[state.index];

  tracks.forEach((track, i) => {
    const row = el("div", "row");
    if (current && uid(current) === uid(track)) row.setAttribute("data-playing", "");

    row.append(el("div", "row__idx", String(i + 1)));

    const art = el("div", "row__art");
    const artSrc = artUrl(track);
    if (artSrc) art.style.backgroundImage = cssUrl(artSrc);
    row.append(art);

    const main = el("div", "row__main");
    main.append(el("div", "row__title", track.title));
    main.append(el("div", "row__artist", track.artist));
    row.append(main);

    if (opts.showSource) {
      const cell = el("div", "row__album");
      const label = state.providers.find((p) => p.id === track.provider)?.label || track.provider;
      cell.append(el("span", "badge", label));
      row.append(cell);
    } else {
      row.append(el("div", "row__album", track.album || ""));
    }

    row.append(
      el("div", "row__dur", track.duration_ms ? fmtTime(track.duration_ms / 1000) : "—")
    );

    const menu = el("button", "row__menu");
    menu.innerHTML =
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
    menu.onclick = (e) => {
      e.stopPropagation();
      openMenu(e, track, opts.playlistId);
    };
    row.append(menu);

    // Проигрываем весь показанный список — так очередь совпадает с тем,
    // что человек видит на экране.
    row.ondblclick = () => playFrom(tracks, i);
    row.onclick = (e) => {
      if (e.detail === 1) return;
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu(e, track, opts.playlistId);
    };
    wrap.append(row);
  });

  return wrap;
}

/* --- Контекстное меню ---------------------------------------------------- */
function openMenu(event, track, fromPlaylistId) {
  document.querySelector(".menu")?.remove();

  const menu = el("div", "menu");
  const add = (label, fn) => {
    const b = el("button", null, label);
    b.onclick = () => {
      menu.remove();
      fn();
    };
    menu.append(b);
  };

  add("Слушать", () => playFrom([track], 0));
  add("В очередь", () => {
    state.queue.push(track);
    toast(`«${track.title}» — в очереди`);
  });

  const liked = state.library.liked.some((t) => uid(t) === uid(track));
  add(liked ? "Убрать из любимого" : "В любимое", () => toggleLike(track));

  menu.append(document.createElement("hr"));

  if (state.library.playlists.length) {
    for (const pl of state.library.playlists) {
      add(`Добавить в «${pl.name}»`, () => {
        if (pl.tracks.some((t) => uid(t) === uid(track))) {
          toast("Уже в этом плейлисте");
          return;
        }
        pl.tracks.push(track);
        saveLibrary();
        toast(`Добавлено в «${pl.name}»`);
      });
    }
  }

  add("Новый плейлист…", () => {
    const name = prompt("Название плейлиста");
    if (!name || !name.trim()) return;
    state.library.playlists.push({ id: crypto.randomUUID(), name: name.trim(), tracks: [track] });
    saveLibrary();
  });

  if (fromPlaylistId) {
    menu.append(document.createElement("hr"));
    add("Убрать из плейлиста", () => {
      const pl = state.library.playlists.find((p) => p.id === fromPlaylistId);
      pl.tracks = pl.tracks.filter((t) => uid(t) !== uid(track));
      saveLibrary();
      render();
    });
  }

  if (track.web_url) {
    menu.append(document.createElement("hr"));
    add("Открыть оригинал", () => bridge.openExternal(track.web_url));
  }

  document.body.append(menu);

  // Прижимаем меню к экрану, если оно вылезает за нижнюю/правую границу.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(event.clientX, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(event.clientY, window.innerHeight - r.height - 8) + "px";

  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function toggleLike(track) {
  const i = state.library.liked.findIndex((t) => uid(t) === uid(track));
  if (i >= 0) state.library.liked.splice(i, 1);
  else state.library.liked.unshift(track);
  saveLibrary();
  syncPlayer();
  if (state.view.name === "liked") render();
}

/* ---------------------------------------------------------------------------
   Воспроизведение

   Движка два, потому что источники принципиально разные. SoundCloud и файлы —
   это поток байт, его играет <audio> через прокси в ядре. YouTube прямых ссылок
   на аудио анонимным клиентам не отдаёт, поэтому его треки играет официальный
   IFrame Player в скрытом окне. Наружу оба движка выглядят одинаково.
   --------------------------------------------------------------------------- */
const audioEngine = {
  id: "audio",
  load(track) {
    audio.src = url(`/api/stream/${track.provider}/${encodeURIComponent(track.id)}`);
    return audio.play();
  },
  play: () => audio.play(),
  pause: () => audio.pause(),
  stop() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  },
  seek: (sec) => (audio.currentTime = sec),
  volume: (v) => (audio.volume = v),
};

const ytEngine = {
  id: "yt",
  load(track) {
    // Команда уходит в скрытое окно; играть начнёт оно само, по событию ready.
    bridge.yt.cmd("volume", state.volume);
    bridge.yt.cmd("load", track.id);
    return Promise.resolve();
  },
  play: () => bridge.yt.cmd("play"),
  pause: () => bridge.yt.cmd("pause"),
  stop: () => bridge.yt.cmd("stop"),
  seek: (sec) => bridge.yt.cmd("seek", sec),
  volume: (v) => bridge.yt.cmd("volume", v),
};

const engineFor = (track) => (track.provider === "ytmusic" ? ytEngine : audioEngine);

function playFrom(list, index) {
  state.queue = list.slice();
  state.index = index;
  state.history = [];
  playCurrent();
}

async function playCurrent() {
  const track = state.queue[state.index];
  if (!track) return;

  const engine = engineFor(track);
  // Иначе прошлый источник продолжит играть поверх нового.
  if (state.engine && state.engine !== engine) state.engine.stop();
  state.engine = engine;

  state.position = 0;
  state.duration = track.duration_ms ? track.duration_ms / 1000 : 0;
  engine.volume(state.volume);

  try {
    await engine.load(track);
    state.playing = true;
  } catch {
    state.playing = false;
    toast(`Не удалось включить «${track.title}»`);
  }

  updateProgress();
  syncPlayer();
  render();
  updateMediaSession(track);
}

function next(auto = false) {
  if (!state.queue.length) return;

  if (auto && state.repeat === "one") {
    state.engine.seek(0);
    state.engine.play();
    return;
  }

  if (state.shuffle) {
    state.history.push(state.index);
    // Один трек в очереди — рандом бессмыслен, иначе избегаем повтора текущего.
    let i = state.index;
    if (state.queue.length > 1) {
      while (i === state.index) i = Math.floor(Math.random() * state.queue.length);
    }
    state.index = i;
    return playCurrent();
  }

  if (state.index + 1 < state.queue.length) {
    state.index++;
    return playCurrent();
  }

  if (state.repeat === "all") {
    state.index = 0;
    return playCurrent();
  }

  // Конец очереди: останавливаемся, но оставляем трек в плеере.
  state.playing = false;
  state.engine.pause();
  syncPlayer();
}

function prev() {
  // Первые секунды трека «назад» означает предыдущий, дальше — в начало текущего.
  if (state.position > 3) {
    state.engine.seek(0);
    return;
  }
  if (state.shuffle && state.history.length) {
    state.index = state.history.pop();
    return playCurrent();
  }
  if (state.index > 0) {
    state.index--;
    return playCurrent();
  }
  state.engine.seek(0);
}

/** Единственное место, где прогресс попадает в интерфейс — движки лишь пишут в state. */
function updateProgress() {
  const d = state.duration;
  $("#t-cur").textContent = fmtTime(state.position);
  $("#t-dur").textContent = fmtTime(d);
  $("#seek-fill").style.width = d > 0 ? (state.position / d) * 100 + "%" : "0%";
}

/**
 * Discord ведёт полосу прогресса сам, поэтому ему нужен не поток тиков, а снимок
 * состояния в моменты, когда оно действительно меняется, — то есть здесь и на перемотке.
 */
function pushPresence(track) {
  bridge.discord.setTrack(
    track
      ? {
          title: track.title,
          artist: track.artist,
          album: track.album || "",
          artwork: artUrl(track),
          position: state.position,
          duration: state.duration,
          playing: state.playing,
        }
      : null
  );
}

function syncPlayer() {
  const track = state.queue[state.index];
  const player = $("#player");
  player.hidden = !track;
  pushPresence(track);
  if (!track) return;

  $("#np-title").textContent = track.title;
  $("#np-artist").textContent = track.artist;
  const artSrc = artUrl(track);
  $("#np-cover").style.backgroundImage = artSrc ? cssUrl(artSrc) : "none";
  $("#np-source").textContent =
    state.providers.find((p) => p.id === track.provider)?.label || track.provider;

  $("#np-like").toggleAttribute(
    "data-on",
    state.library.liked.some((t) => uid(t) === uid(track))
  );

  $("#play-icon").innerHTML = state.playing
    ? '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>'
    : '<path d="M7 4l13 8-13 8z"/>';
  $("#play").title = state.playing ? "Пауза" : "Play";

  $("#shuffle").toggleAttribute("data-on", state.shuffle);
  $("#repeat").toggleAttribute("data-on", state.repeat !== "off");
  $("#repeat").title =
    state.repeat === "one" ? "Повтор трека" : state.repeat === "all" ? "Повтор очереди" : "Повтор";
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  const art = artUrl(track);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || "",
    artwork: art ? [{ src: art }] : [],
  });
  navigator.mediaSession.setActionHandler("play", togglePlay);
  navigator.mediaSession.setActionHandler("pause", togglePlay);
  navigator.mediaSession.setActionHandler("previoustrack", prev);
  navigator.mediaSession.setActionHandler("nexttrack", () => next(false));
}

function togglePlay() {
  if (!state.queue.length || !state.engine) return;
  if (state.playing) {
    state.engine.pause();
    state.playing = false;
  } else {
    state.engine.play();
    state.playing = true;
  }
  syncPlayer();
}

/* --- Поиск --------------------------------------------------------------- */
let searchSeq = 0;
async function runSearch(q) {
  q = q.trim();
  state.query = q;
  if (!q) {
    state.results = [];
    state.searchErrors = [];
    state.searching = false;
    return render();
  }

  const seq = ++searchSeq;
  state.searching = true;
  render();

  try {
    const params = new URLSearchParams({
      q,
      providers: [...state.enabled].join(","),
      limit: "25",
    });
    const res = await api("/api/search?" + params).then((r) => r.json());
    // Ответы приходят вразнобой — показываем только самый свежий запрос.
    if (seq !== searchSeq) return;
    state.results = res.tracks;
    state.searchErrors = res.errors;
  } catch (e) {
    if (seq !== searchSeq) return;
    state.results = [];
    state.searchErrors = [{ provider: "—", message: e.message }];
  }
  state.searching = false;
  render();
}

/* --- Сайдбар ------------------------------------------------------------- */
function renderSidebar() {
  const box = $("#playlists");
  box.replaceChildren();
  for (const pl of state.library.playlists) {
    const b = el("button", "pl");
    b.dataset.id = pl.id;
    b.append(el("span", "pl__name", pl.name));
    b.append(el("span", "pl__count", String(pl.tracks.length)));
    b.onclick = () => {
      state.view = { name: "playlist", id: pl.id };
      render();
    };
    if (state.view.name === "playlist" && state.view.id === pl.id) b.setAttribute("data-active", "");
    box.append(b);
  }
}

/* --- Обвязка ------------------------------------------------------------- */
function bindChrome() {
  document
    .querySelectorAll("[data-win]")
    .forEach((b) => (b.onclick = () => bridge.window(b.dataset.win)));

  document.querySelectorAll(".nav").forEach((b) => {
    b.onclick = async () => {
      state.view = { name: b.dataset.view };
      if (b.dataset.view === "local") await loadLocal();
      render();
    };
  });

  $("#new-playlist").onclick = () => {
    const name = prompt("Название плейлиста");
    if (!name || !name.trim()) return;
    const pl = { id: crypto.randomUUID(), name: name.trim(), tracks: [] };
    state.library.playlists.push(pl);
    saveLibrary();
    state.view = { name: "playlist", id: pl.id };
    render();
  };

  $("#play").onclick = togglePlay;
  $("#next").onclick = () => next(false);
  $("#prev").onclick = prev;
  $("#np-like").onclick = () => {
    const t = state.queue[state.index];
    if (t) toggleLike(t);
  };

  $("#shuffle").onclick = () => {
    state.shuffle = !state.shuffle;
    syncPlayer();
  };
  $("#repeat").onclick = () => {
    state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
    syncPlayer();
  };

  bindSlider($("#seek"), (ratio) => {
    if (!state.engine || !(state.duration > 0)) return;
    state.position = ratio * state.duration;
    state.engine.seek(state.position);
    updateProgress();
    // Метки времени в Discord после перемотки разъезжаются с музыкой.
    pushPresence(state.queue[state.index]);
  });
  bindSlider($("#vol"), (ratio) => {
    state.volume = ratio;
    if (state.engine) state.engine.volume(ratio);
    else audio.volume = ratio;
    $("#vol-fill").style.width = ratio * 100 + "%";
    localStorage.setItem("volume", String(ratio));
  });

  // --- события <audio> ---
  const fromAudio = () => state.engine === audioEngine;

  audio.addEventListener("timeupdate", () => {
    if (!fromAudio()) return;
    state.position = audio.currentTime;
    if (Number.isFinite(audio.duration)) state.duration = audio.duration;
    updateProgress();
  });
  audio.addEventListener("ended", () => fromAudio() && next(true));
  audio.addEventListener("play", () => {
    if (!fromAudio()) return;
    state.playing = true;
    syncPlayer();
  });
  audio.addEventListener("pause", () => {
    if (!fromAudio()) return;
    state.playing = false;
    syncPlayer();
  });
  audio.addEventListener("error", () => {
    // stop() снимает src и сам порождает error — это не сбой, сообщать не о чем.
    if (!fromAudio() || !audio.getAttribute("src")) return;
    const t = state.queue[state.index];
    toast(t ? `Поток недоступен: «${t.title}»` : "Поток недоступен");
  });

  // --- события скрытого плеера YouTube ---
  bridge.yt.onEvent((e) => {
    // Просьба вмешаться приходит и до того, как что-то заиграло, — не фильтруем.
    if (e.type === "needs-attention") {
      toast(e.message, 9000);
      return;
    }
    if (state.engine !== ytEngine) return;
    switch (e.type) {
      case "time":
        state.position = e.position;
        if (e.duration > 0) state.duration = e.duration;
        if (e.playing !== state.playing) {
          state.playing = e.playing;
          syncPlayer();
        }
        updateProgress();
        break;
      case "paused":
        state.playing = false;
        syncPlayer();
        break;
      case "ended":
        next(true);
        break;
      case "error": {
        const t = state.queue[state.index];
        toast(`${t ? `«${t.title}»: ` : ""}${e.message}`, 6000);
        // Один запрещённый к встраиванию трек не должен вставать поперёк очереди.
        if (state.queue.length > 1) next(false);
        break;
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    const typing = e.target.tagName === "INPUT";
    if (e.code === "Space" && !typing) {
      e.preventDefault();
      togglePlay();
    }
    if (e.ctrlKey && e.key === "f") {
      e.preventDefault();
      state.view = { name: "search" };
      render();
    }
    if (!typing && e.key === "ArrowRight" && e.ctrlKey) next(false);
    if (!typing && e.key === "ArrowLeft" && e.ctrlKey) prev();
  });
}

/** Клик и перетаскивание по дорожке прогресса/громкости. */
function bindSlider(track, onChange) {
  const ratioAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  track.addEventListener("mousedown", (e) => {
    onChange(ratioAt(e.clientX));
    const move = (ev) => onChange(ratioAt(ev.clientX));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

boot();
