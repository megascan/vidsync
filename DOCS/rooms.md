# Rooms

- Created anonymously via `POST /rooms` `{ turnstileToken, videoUrl? }`
- **Empty rooms OK** — room is a sync group; host queues streams after join
- Optional `videoUrl` on create seeds the queue (home UI creates empty)
- Turnstile on create only
- Code is public share secret (treat like unlisted link)
- **Host liveness = heartbeats**, not WS close alone. Socket blips do not kill the room.
- Room dissolves only after **~45s** (`HOST_STALE_MS`) with **no host packets**.
- Host can rejoin: if previous host session is dead, next `hello` claims host.
- Empty room (zero sockets): wipe after **~30s** grace.
- Host = first joiner, re-claim after soft-disconnect, or `transfer_host`.
- Presence: sessionId + nickname (localStorage), no accounts

## Queue (host only)
- `queue_add` / `queue_remove` / `queue_play` / `queue_clear`
- `set_url` = add + play now (compat)
- URLs: **http(s)** — public CDN, localhost, and private LAN allowed
- First add while idle auto-selects that item

## Limits
- Max 20 viewers
- Max 50 queue items
- Nickname max 24 chars
- videoUrl max 2048 chars, https only
