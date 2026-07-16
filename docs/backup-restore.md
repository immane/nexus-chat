# Backup & Restore

> Procedures for backing up and restoring Nexus Chat data. These recipes apply to a single-instance deployment. For multi-instance or clustered setups, consult your infrastructure provider.

## PostgreSQL

### Backup (pg_dump)

```bash
# Full database backup (custom format, compressed)
pg_dump -h localhost -U nexus -d nexus_chat \
  -Fc -f nexus_chat_$(date +%Y%m%d_%H%M%S).dump

# SQL plain-text backup (for manual inspection)
pg_dump -h localhost -U nexus -d nexus_chat \
  -Fp -f nexus_chat_$(date +%Y%m%d_%H%M%S).sql

# Schema-only backup
pg_dump -h localhost -U nexus -d nexus_chat \
  --schema-only -f nexus_chat_schema_$(date +%Y%m%d_%H%M%S).sql
```

### Restore (pg_restore)

```bash
# Restore from custom format dump (requires clean database first)
psql -h localhost -U nexus -d postgres -c "DROP DATABASE IF EXISTS nexus_chat;"
psql -h localhost -U nexus -d postgres -c "CREATE DATABASE nexus_chat OWNER nexus;"

pg_restore -h localhost -U nexus -d nexus_chat \
  -Fc nexus_chat_20260705_120000.dump

# Restore from SQL plain-text dump
psql -h localhost -U nexus -d nexus_chat \
  -f nexus_chat_20260705_120000.sql
```

### Scheduled Backups (cron)

```bash
# Daily backup at 2 AM, keep 14 days
# Add to crontab:
# 0 2 * * * pg_dump -h localhost -U nexus -d nexus_chat -Fc -f /backups/nexus_chat_$(date +\%Y\%m\%d).dump
# 0 3 * * * find /backups -name 'nexus_chat_*.dump' -mtime +14 -delete
```

### WAL Archiving (Production)

For point-in-time recovery, enable WAL archiving in `postgresql.conf`:

```
wal_level = replica
archive_mode = on
archive_command = 'cp %p /wal_archive/%f'
```

## Redis

### Backup (RDB Snapshot)

```bash
# Trigger an immediate RDB save
redis-cli BGSAVE

# Copy the latest dump file
cp /var/lib/redis/dump.rdb /backups/redis_$(date +%Y%m%d_%H%M%S).rdb
```

### Restore

```bash
# Stop Redis, restore dump file, start Redis
redis-cli SHUTDOWN
cp /backups/redis_20260705_120000.rdb /var/lib/redis/dump.rdb
# Start Redis (will load dump.rdb automatically)
```

### AOF Persistence (Production)

For durability, enable AOF in `redis.conf`:

```
appendonly yes
appendfsync everysec
```

### Backup via SAVE (blocking)

```bash
# Blocking save (use BGSAVE in production)
redis-cli SAVE
```

## File Storage (S3 / Object Storage)

Phase 1 includes dev file upload in the web/desktop UI via `/dev-upload`. Dev file bytes are in-memory and disappear on server restart. File metadata is persisted in PostgreSQL. Production object storage (S3-compatible) is planned for Phase 2:

### Backup Strategy

1. **Enable S3 versioning** on the object bucket to preserve file history
2. **Enable S3 cross-region replication** for disaster recovery
3. **Use `aws s3 sync`** or `rclone` for offline backups:

```bash
# Mirror S3 bucket to local storage
aws s3 sync s3://nexus-chat-prod/attachments /backups/s3/attachments/

# Or using rclone
rclone sync s3:nexus-chat-prod/attachments /backups/s3/attachments/
```

### Attachment Metadata

Attachment records in PostgreSQL must be backed up alongside file objects. The `attachments` table contains:

- `id`, `messageId`, `channelId`, `workspaceId`
- `filename`, `mimeType`, `sizeBytes`, `objectKey`
- `createdAt`, `uploadedBy`

Restoring attachments requires both the PostgreSQL data and the matching S3 objects.

## Data Export API (GDPR)

For GDPR compliance (data portability, right to access), provide a user data export endpoint:

### Export Request

```
POST /api/export/request
Authorization: Bearer <jwt>

Response:
{
  "status": "processing",
  "exportId": "exp_abc123",
  "estimatedReadyAt": "2026-07-06T02:00:00Z"
}
```

### Export Download

```
GET /api/export/download/:exportId
Authorization: Bearer <jwt>

Response: application/zip
```

### Contents of Export Archive

```
export_<userId>_<timestamp>.zip
├── profile.json           # User profile information
├── workspaces/            # Joined workspaces
│   └── <workspaceId>.json
├── messages/              # Messages sent by the user
│   ├── normal_channels/
│   │   └── <channelId>.json
│   └── dm_channels/
│       └── <channelId>.json        # Decryptable only if private key available
├── attachments.json       # List of uploaded file references
└── metadata.json          # Export timestamp, version, checksums
```

> **Note on E2E data:** Messages in E2E-encrypted channels are stored as ciphertext on the server. The user must have access to their ECDH private key on the client to decrypt exported E2E message history. The server cannot decrypt this data.

## Disaster Recovery Checklist

1. [ ] Restore PostgreSQL from latest `pg_dump`
2. [ ] Restore Redis from latest `dump.rdb`
3. [ ] Verify database connectivity: `psql -h localhost -U nexus -d nexus_chat -c "SELECT 1;"`
4. [ ] Verify Redis connectivity: `redis-cli PING`
5. [ ] Run database migrations: `pnpm db:migrate`
6. [ ] Run smoke tests: `pnpm smoke:tui`
7. [ ] Verify API health: `curl http://127.0.0.1:4000/healthz`
8. [ ] Verify auth flow: login with seed credentials
9. [ ] Restore S3 objects (Phase 2+): `aws s3 sync`
10. [ ] Notify users of maintenance completion
