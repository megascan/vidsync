# Sync protocol

Wire: JSON text over WebSocket. Schemas: `packages/shared`.

## PlaybackState
- `version` monotonic
- `videoUrl` https or null (current item)
- `queue` string[] of public https URLs
- `queueIndex` number | null
- `isPlaying`
- `positionMs` at `serverAnchorMs`
- `hostSessionId`
- `updatedAtMs`

Expected position while playing:
`positionMs + (nowMs - serverAnchorMs)` (client may subtract RTT/2).

## Client → server
`hello`, `queue_add`, `queue_remove`, `queue_play`, `queue_clear`, `set_url`, `play`, `pause`, `seek`, `heartbeat`, `transfer_host`, `set_nickname`, `chat`

## Server → client
`welcome`, `state`, `members`, `chat`, `error`

## Chat (stateless)
- `chat` is broadcast-only — not written to DO storage
- No history for late joiners
- Cooldown ~400ms/session; max 280 chars
- Client may keep a short local scrollback only

## Authority
Only host control msgs. Host disconnect → oldest session becomes host.
Max 20 members. Heartbeat ~5s from host while playing → throttled state broadcast.
