# Rooms

- Created anonymously via `POST /rooms` `{ turnstileToken, videoUrl? }`
- **Empty rooms OK** — room is a sync group; host queues streams after join
- Optional `videoUrl` on create seeds the queue (home UI creates empty)
- Turnstile on create only
- Code is public share secret (treat like unlisted link)
- **Room stays alive while any socket is open** — never dissolve for host drop alone.
- Host socket gone: wait **~60s** (`HOST_RECLAIM_MS`) for reconnect, then **promote oldest peer**.
- Host reconnect (hello while host dead): reclaims host immediately.
- Empty room (zero sockets): wipe after **~10 min** (`EMPTY_ROOM_GRACE_MS`).
- Clients auto-reconnect aggressively (desktop + web).
- Presence: sessionId + nickname + optional platform badge.

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
