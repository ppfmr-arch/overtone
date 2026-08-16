*[Русская версия](README.md)*

# Overtone

A desktop music player: one search box across several sources, black-and-grey interface.
Rust core, Electron shell.

## Download

Grab the Windows installer from the [latest release](https://github.com/ppfmr-arch/overtone/releases/latest).
It is unsigned, so SmartScreen will warn on first run — **More info → Run anyway**.

## How it works

```
core/          Rust: HTTP server on 127.0.0.1 (random port)
  providers/   ytmusic · soundcloud · local — one file per source
  stream.rs    audio proxy with Range support (seeking)
app/           Electron: interface only, all source logic lives in the core
```

Electron spawns `mp-core.exe` as a child process and reads the line
`MPCORE_READY <port> <key>` from its stdout. The OS assigns the port, so multiple
copies never collide.

The key lasts exactly one session and is never written to disk. Every API request
must carry it as the `t` parameter, otherwise the core answers 401. Without it any
page open in your browser could reach your library: the port is local but can be
scanned in seconds, and CORS here is deliberately permissive — otherwise the
renderer, which is loaded from `file://`, could not talk to the API at all.

Audio never loads into the browser directly: `<audio>` points at
`http://127.0.0.1:<port>/api/stream/<provider>/<id>`, and the core does the outbound
request with its own headers. Anything else breaks CORS, seeking, or the
short-lived googlevideo links.

## Running from source

```bash
cd core && cargo build --release
```

```bash
cd app && npm install && npm start
```

## Sources

| Source | Search | Playback |
| --- | --- | --- |
| SoundCloud | yes | yes |
| Local files | yes | yes |
| YouTube Music | yes | yes, through a hidden window of the real site |

### About YouTube

Search goes through Innertube across two tabs at once — `Songs` and `Videos`. One
tab is not enough: `Songs` is the licensed catalogue, while everything that exists
on YouTube as a user upload (old underground, covers, rarities) lives only in
`Videos`. The generic unfiltered search is no good either — it drags in playlists
and podcasts. The merged lists are ranked by how many query words matched: each tab
is sorted only within itself, and without a shared ranking two dozen unrelated
same-titled tracks land above the single exact hit.

Playback is the harder part, and the road to something that actually works is worth
writing down — all three options below were tested in practice, not taken from docs.

**A direct audio URL — no.** Every Innertube client (`IOS_MUSIC`, `ANDROID_VR`,
`TVHTML5`, `WEB`, `MWEB`) answers `Sign in to confirm you're not a bot`. `yt-dlp`
says the same even with a JS runtime: its debug output shows
`PO Token Providers: none`. Working around this without cookies requires a PO token
generator — a separate plugin plus a local server that breaks every time YouTube
changes something.

**The embeddable IFrame player — also no.** It returns error 150 for any video,
including ones that are definitely embeddable. It is not about the tracks or the IP:
the same video embeds perfectly from the real site over https. YouTube simply does
not accept `http://127.0.0.1` as an origin.

**What does work — the site itself.** The app keeps a hidden window with the real
`music.youtube.com` and drives the ordinary `<video>` element on the page. The origin
is genuine, embedding restrictions do not apply, and the site's own player deals with
PO tokens. No browser cookies, no account sign-in, no third-party tools.

That window lives in its own session (`persist:ytmusic`) and never touches your
browser's. On first launch YouTube shows its consent page — the window opens by
itself and you accept once, by hand. After that it stays hidden; you can bring it
back from **Settings → Show YouTube window**.

The cost is exactly the same as listening on the site: an anonymous listener may get
ads and interstitials.

### About SoundCloud

The `client_id` is scraped from the web player bundle and cached; on a 401 it is
dropped and fetched again. A `track_authorization` from the track card is needed on
top of that — without it the media endpoint returns 404 for everything.
Subscription-only or region-locked tracks will not play.

## Adding your own source

Implement the `Provider` trait (`core/src/providers/mod.rs`) — `search` and
`resolve` — and add one line to `Registry::new`. The interface, the filters and the
playlists pick up the new source on their own, with no frontend changes.

## Data

Playlists, likes and the folder list live in `%APPDATA%\Overtone\library.json`.
Writes are atomic, through a temporary file.

The hidden YouTube session (cookies, consent, caches) sits separately in
`%APPDATA%\Overtone\Partitions\ytmusic`. Deleting that folder resets YouTube; you
will be asked to accept the terms once more.

## Discord

Your profile shows "Listening to Overtone" with the title, the artist and a progress
bar. Cover art is picked up for YouTube Music and SoundCloud; local files are served
from `127.0.0.1`, and Discord — which fetches the image from its own side — cannot
reach them.

Rich Presence is always tied to an application in the
[developer portal](https://discord.com/developers/applications): the name above the
status and the image keys come from there. A different application id can be supplied
via `OVERTONE_DISCORD_APP_ID` without rebuilding; an empty value disables the feature
entirely. Optional: assets named `cover`, `play` and `pause` replace the empty slot
with icons — without them the status stays text-only.

There is no library here: `discord-rpc` on npm is abandoned, and the whole protocol
is `[opcode u32 LE][length u32 LE][JSON]` frames over the `discord-ipc-N` named pipe.

## Keyboard

| | |
| --- | --- |
| `Space` | pause / play |
| `Ctrl + F` | focus search |
| `Ctrl + ←` / `Ctrl + →` | previous / next |
| double-click a track | play the list from that point |
| right-click a track | menu: queue, likes, playlists |

## Building the installer

```bash
cd app && npm run dist
```

`electron-builder` copies `core/target/release/mp-core.exe` into the app resources,
so the core must be built in release mode first.

## Caveat

The sources are queried through their internal web APIs, not public partner ones.
That is not technically forbidden, but it does not always match the terms of service
of YouTube and SoundCloud, and those APIs can change without notice. Fine for
personal use; for distribution you would want official APIs, or local files only.

## License

[GPL-3.0](LICENSE). Copyleft: fork, modify and redistribute freely, but any derivative
work may only be distributed with its source and under the same license. You cannot
take this code and close it.
