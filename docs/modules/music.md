# Muzyka

Włącz moduł **Muzyka** w panelu V1 lub V2. Członkowie na kanale głosowym używają komendy `/music`:

| Komenda | Działanie |
| --- | --- |
| `/music play url:<link> [title]` | Odtwarza lub dodaje do kolejki bezpośredni link do pliku audio (MP3, OGG, AAC, FLAC, WAV, WebM) albo strumienia radiowego. |
| `/music radio [station]` | Odtwarza stację zapisaną w panelu. Bez nazwy pokazuje listę stacji. |
| `/music queue`, `/music nowplaying` | Kolejka i bieżący utwór. |
| `/music skip`, `/music pause`, `/music resume` | Sterowanie odtwarzaniem. |
| `/music stop` | Zatrzymuje muzykę, czyści kolejkę i opuszcza kanał. |

## Ustawienia

- **Rola DJ-a** (opcjonalnie): gdy ustawiona, tylko osoby z tą rolą lub z uprawnieniem Zarządzanie serwerem mogą puszczać i sterować muzyką. Komendy `queue` i `nowplaying` są zawsze otwarte.
- **Pozwól puszczać dowolne linki**: wyłącz, aby dozwolone były tylko stacje z listy (`/music radio`).
- **Maksymalna długość kolejki** (1–200), **maksymalna długość utworu** (1–720 min; dotyczy też nieskończonych stacji radiowych) i **czas bezczynności** przed opuszczeniem kanału (1–60 min).
- **Stacje radiowe**: jedna w linii, w formacie `Nazwa | https://adres-strumienia`. Maksymalnie 25.

Bot opuszcza kanał także wtedy, gdy zostaje na nim sam przez minutę, a przy wyrzuceniu go z kanału czyści sesję.

## Ograniczenia i bezpieczeństwo

- **Nie ma YouTube ani Spotify.** Pobieranie z tych serwisów łamie ich regulaminy, więc moduł obsługuje tylko bezpośrednie linki do audio i strumienie radiowe. Playlisty (`.m3u`, `.pls`, HLS `.m3u8`) nie są obsługiwane — podaj bezpośredni adres strumienia.
- Dozwolone są tylko publiczne adresy `http://` i `https://`. Adresy z loginem i hasłem, localhost, sieci prywatne, `169.254.x.x` (metadane chmury) i podobne są odrzucane, także po przekierowaniach i przy każdym połączeniu (ochrona przed DNS rebinding).
- Pobieranie robi sam bot, a FFmpeg dostaje dane wyłącznie przez stdin, bez dostępu do plików i sieci.
- Limity: 10 utworów jednej osoby w kolejce, 5 serwerów jednocześnie, 3 s przerwy między komendami `play` jednej osoby.
- Soundboard i muzyka nie działają naraz na jednym serwerze: jeśli soundboard trzyma kanał, najpierw kliknij „Rozłącz”.

## Wymagania

- Uprawnienia bota na kanale głosowym: Wyświetlanie kanału, Połącz, Mów.
- FFmpeg: pakiet `ffmpeg-static` albo systemowy `ffmpeg` (lub zmienna `FFMPEG_PATH`). Jeśli npm blokuje skrypty instalacyjne, uruchom `npm install-scripts approve ffmpeg-static` i zainstaluj ponownie.
- Komenda `/music` zostanie zarejestrowana przy następnym starcie (`REGISTER_COMMANDS_ON_START=true`) albo przez `npm run register`.

Błędy są zapisywane w konsoli jako `module:music`.
