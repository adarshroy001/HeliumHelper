# system module

The backend's own housekeeping: jobs that keep the platform healthy rather than serve a business feature.

## Owns

| Kind | Name | Notes |
| --- | --- | --- |
| Queue | `system-jobs` (+ `system-jobs-dlq`) | Scheduled housekeeping messages |
| Message | `system.heartbeat.tick` | Empty data |
| Schedule | `system-heartbeat` | Every 5 minutes, Asia/Kolkata |
| Consumer | `HeartbeatConsumer` | Logs `scheduler heartbeat` with `lagMs` |

No collections, no routes, no error codes.

## If the heartbeat stops

The `scheduler heartbeat` log line appears every 5 minutes in the worker's logs. If it stops, check in this order: the EventBridge schedule (AWS) or the worker's local timer (`local schedules started`), the `system-jobs` queue depth, then the worker service.
