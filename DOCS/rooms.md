# Rooms

- Created anonymously via `POST /rooms` `{ turnstileToken, videoUrl? }`
- **Empty rooms OK** — room is a sync group; host queues streams after join
- Optional `videoUrl` on create seeds the queue (home UI creates empty)
- Turnstile on create only
- Code is public share secret (treat like unlisted link)
- Empty GC: when last client disconnects, DO alarm wipes room after ~30s grace (reconnect/refresh). No long-lived empty rooms.
- Host = first joiner; transfer on disconnect to oldest remaining
- Presence: sessionId + nickname (localStorage), no accounts

## Queue (host only)
- `queue_add` / `queue_remove` / `queue_play` / `queue_clear`
- `set_url` = add + play now (compat)
- URLs: **public HTTPS only** (no localhost / private hosts)
- First add while idle auto-selects that item

## Limits
- Max 20 viewers
- Max 50 queue items
- Nickname max 24 chars
- videoUrl max 2048 chars, https only
