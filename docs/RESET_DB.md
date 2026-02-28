# Reset PostgreSQL Database (EchoChat)

⚠️ **Destructive:** these procedures delete all users, rooms, messages, keys, etc.

## Option 1: Drop + recreate the database (recommended)

```bash
# Stop your server first (CTRL+C)
cd ~/Projects/Echo-Chat-main
source .venv/bin/activate
bash tools/reset_db_fresh.sh
python main.py
```

The script will attempt to create a backup first if `pg_dump` is available.

## Option 2: Wipe tables without dropping the database

Use this if you do not have permission to drop/create databases.

```bash
# Stop your server first (CTRL+C)
cd ~/Projects/Echo-Chat-main
source .venv/bin/activate
bash tools/reset_db_schema_only.sh
python main.py
```
