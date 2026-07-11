# Sync protocol

Wire: JSON text over WebSocket. Schemas: `packages/shared`.

## PlaybackState
- `version` monotonic
- `videoUrl` https or null (current item)
- `queue` string[] of http(s) URLs (public or LAN)
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
Only host control msgs. Host WS drop does not dissolve; **45s without host packets** does.
Max 20 members. Host heartbeat **~5s always** while in room (play or pause) → throttled state broadcast + room liveness.

## Client reconnect (DO drops)

Cloudflare DO WebSockets can drop (hibernation / edge). Clients must reconnect:

| Client | Behavior |
|---|---|
| Desktop | Auto-reconnect with backoff (0.5s→10s). Emits `reconnecting` then new `welcome`. Stops on user leave or `room_closed`. Host **MediaHub keeps running** across reconnect. |
| Web | Same pattern in `SyncClient` |

SessionId changes after reconnect; server re-claims host if previous host socket is dead.
