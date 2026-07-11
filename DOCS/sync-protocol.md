# Sync protocol

Wire: JSON text over WebSocket. Schemas: `packages/shared`.

## PlaybackState
- `version` monotonic
- `videoUrl` https or null
- `isPlaying`
- `positionMs` at `serverAnchorMs`
- `hostSessionId`
- `updatedAtMs`

Expected position while playing:
`positionMs + (nowMs - serverAnchorMs)` (client may subtract RTT/2).

## Client → server
`hello`, `set_url`, `play`, `pause`, `seek`, `heartbeat`, `transfer_host`, `set_nickname`

## Server → client
`welcome`, `state`, `members`, `error`

## Authority
Only host control msgs. Host disconnect → oldest session becomes host.
Max 20 members. Heartbeat ~5s from host while playing → throttled state broadcast.
