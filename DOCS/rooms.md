# Rooms

- Created anonymously via `POST /rooms` `{ turnstileToken, videoUrl? }`
- **Empty rooms OK** — room is a sync group; host queues streams after join
- Optional `videoUrl` on create seeds the queue (home UI creates empty)
- Turnstile on create only
- Code is public share secret (treat like unlisted link)
- **Host leave = room death**: no host transfer. Server broadcasts `room_closed`, closes all sockets, wipes DO storage immediately. Clients return to home.
- Empty GC (no host-leave): last client disconnect → wipe after ~5s grace.
- Host = first joiner only (or explicit `transfer_host` before leave).
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
