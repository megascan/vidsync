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
`positionMs + (nowMs - serverAnchorMs) + hostOneWayMs`

`hostOneWayMs ≈ host.rttMs / 2` — host sampled position before the packet
hit the DO; media advanced that much while in flight.

Helper: `expectedPositionMs()` in `packages/shared` (server uses this on host reclaim / promote so reconnect does not rewind the room).

## Latency (`ping` / `pong`)

| Dir | Msg | Fields |
|---|---|---|
| C→S | `ping` | `clientTimeMs`, optional `rttMs` (last measured) |
| S→C | `pong` | `clientTimeMs` (echo), `serverTimeMs` |

Client RTT: `now - clientTimeMs`. Clock: `offset ≈ serverTimeMs + RTT/2 - now`.  
Server stores `rttMs` on the session and includes it on `members` (throttled broadcast).

Desktop pings every ~2s (plus one right after hello).

## Client → server
`hello`, `ping`, `queue_add`, `queue_remove`, `queue_play`, `queue_clear`, `set_url`, `play`, `pause`, `seek`, `heartbeat`, `transfer_host`, `set_nickname`, `chat`

## Server → client
`welcome`, `state`, `members`, `pong`, `chat`, `error`, `room_closed` (defined; not currently emitted by any production path)

## Chat (stateless)
- `chat` is broadcast-only — not written to DO storage
- No history for late joiners
- Cooldown ~400ms/session; max 280 chars
- Client may keep a short local scrollback only

## Authority
Only host control msgs. Host WS drop does **not** dissolve the room.

- **Host reclaim:** same `clientKey` may instant-reclaim on hello when the prior host socket is dead. Other members wait `HOST_RECLAIM_MS` (60s), then oldest hello'd member is promoted.
- **Empty wipe:** no sockets for `EMPTY_ROOM_GRACE_MS` (10 min).
- Max 20 members (counted after hello). Pre-hello sockets age out at ~30s.
- Host heartbeat **~2s** while in room (play or pause). DO applies position every heartbeat; version bump + state broadcast about every **8s**.

## Client reconnect (DO drops)

Cloudflare DO WebSockets can drop (hibernation / edge). Clients must reconnect:

| Client | Behavior |
|---|---|
| Desktop | Auto-reconnect with backoff (200ms→5s). Emits `reconnecting` then new `welcome`. Stops on user leave or `room_closed`. Stale outbound heartbeats drained before new session. Host **MediaHub keeps running** across reconnect. |

SessionId changes after reconnect. Server re-claims host only for the same `clientKey` (or after reclaim grace → promote).
