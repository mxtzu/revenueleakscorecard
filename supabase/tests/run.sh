#!/usr/bin/env bash
#
# Apply the migrations to a scratch database and run the CRM schema assertions.
#
#   CRM_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres ./supabase/tests/run.sh
#
# The URL must point at a Postgres 16 server you are happy for this script to
# create and drop a database on. It creates `crm_schema_test`, applies
# auth_shim.sql (a stand-in for Supabase's auth schema) plus every migration in
# order, runs crm_schema_test.sql, and leaves the database in place for
# inspection.
#
# Never point this at a real Supabase project: it drops the test database
# first, and the auth shim would collide with the real `auth` schema.
set -euo pipefail

if [ -z "${CRM_TEST_DATABASE_URL:-}" ]; then
  echo "CRM_TEST_DATABASE_URL is not set." >&2
  echo "Example: CRM_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres $0" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install the PostgreSQL client (postgresql-client-16)." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="crm_schema_test"

# Swap the database name in the URL, keeping any query string (?host=, sslmode=)
# intact — a naive suffix strip would eat it and silently connect elsewhere.
url_without_query="${CRM_TEST_DATABASE_URL%%\?*}"
if [ "$url_without_query" = "$CRM_TEST_DATABASE_URL" ]; then
  query=""
else
  query="?${CRM_TEST_DATABASE_URL#*\?}"
fi
TARGET="${url_without_query%/*}/$DB$query"

echo "→ recreating $DB"
psql "$CRM_TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 \
  -c "drop database if exists $DB;" \
  -c "create database $DB;"

echo "→ applying auth shim"
psql "$TARGET" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/auth_shim.sql"

for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ applying $(basename "$migration")"
  psql "$TARGET" -q -v ON_ERROR_STOP=1 -f "$migration"
done

echo "→ running assertions"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/crm_schema_test.sql"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/sales_workflow_test.sql"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/calendar_sync_test.sql"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/payments_test.sql"
psql "$TARGET" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/outreach_test.sql"
