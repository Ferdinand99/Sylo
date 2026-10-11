# Dashboard soundboard

In dashboard V1, select a server and open **Dźwięki na VC** under Utilities.
Upload an audio file, give it a name, select a normal voice channel and click
**Odtwórz**. The bot joins, plays the clip and disconnects. **Zatrzymaj i rozłącz**
stops an active clip. The selected channel is remembered per server in the browser.
Stage channels are not supported.

For game shows or repeated sound effects, click **Dołącz i zostań** to keep the
bot connected without playing anything. **Pozostań na VC po odtworzeniu klipu**
also keeps the connection after a sound. Later clips reuse that connection;
**Zatrzymaj i rozłącz** leaves the channel, including during playback or joining.
To switch channels, disconnect first. This mode lasts until explicitly
disconnected, the connection fails, or the bot restarts. It does not reconnect
automatically after a restart and never records or processes microphone audio.

## Requirements

- Node.js 22.12 or newer (the Pelican Node 22 image is suitable).
- Run `npm install` after updating. `@discordjs/voice` includes DAVE support.
- FFmpeg with the `libopus` encoder. `ffmpeg-static` supplies a binary through its
  installation script. If your npm setup blocks that script, approve just
  `ffmpeg-static` using the mechanism shown by npm, then rerun installation.
  A system `ffmpeg` executable is also supported, or set `FFMPEG_PATH` to its
  absolute path **inside the container**.
- The bot needs View Channel, Connect and Speak on the chosen voice channel.
  Guild Voice States is already requested by Sylo.
- The host/container must allow outgoing Discord voice UDP traffic. No new web
  port, OAuth application, API key or separate bot is required.

## Limits and storage

MP3, WAV, OGG, Opus, M4A, AAC, FLAC and WebM uploads are accepted, up to 8 MiB and
30 seconds. Files must decode as actual audio. Playlists and remote protocols
are rejected. Metadata and the original upload are discarded after conversion.

There are at most 50 clips per server. Files and their index are stored in
`soundboard/<guildId>/` beside `DATABASE_PATH`, normally `data/soundboard/`.
They survive bot restarts and use the same encrypted filesystem when the data
folder is mounted on encrypted storage. Configuration export/import does not
include audio files; back up this folder separately using encrypted backups.
Postgres deployments still store clips locally on the dashboard host.

Only one upload/conversion runs at a time, with a 20-second deadline per FFmpeg
step. Audio is converted to 48 kHz stereo Opus once at upload and streamed without
live transcoding. Playback is limited to one clip per guild, three concurrent
guilds per process and a two-second gap between starts. Voice readiness has a
15-second deadline and playback a 35-second deadline; errors clean up the
connection. Up to three guilds may have a connection, including idle retained
connections. Existing voice connections are not replaced by the soundboard.

The dashboard checks current Manage Server / Administrator or configured
bot-master roles on every request when OAuth is enabled. Upload/play/delete
requests use the existing CSRF protection. Open mode remains for trusted local
use. The bot deafens itself and does not record voice or listen for spoken commands.

## Open-source components

Existing projects reviewed:

- [dominikks/discord-soundboard-bot](https://github.com/dominikks/discord-soundboard-bot)
  (MIT): a standalone Rust/web implementation.
- [christomitov/soundbored](https://github.com/christomitov/soundbored): a standalone
  Elixir implementation.

The integrated Sylo feature is original code; no code from those applications
was copied. It reuses the open-source
[@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice)
(Apache-2.0) playback library and follows its official lifecycle guide.
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) supplies FFmpeg;
its distribution and binary license notices apply to that separate executable.
See the installed dependency packages for their licenses.
