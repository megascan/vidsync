# Rooms

- Created anonymously via `POST /rooms` `{ videoUrl?: string }`
- Code is public share secret (treat like unlisted link)
- Idle GC: DO alarm after 24h with no connections
- Host = first joiner; transfer on disconnect to oldest remaining
- Presence: sessionId + nickname (localStorage), no accounts

## Limits
- Max 20 viewers
- Nickname max 24 chars
- videoUrl max 2048 chars, https only
