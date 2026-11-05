-- Trusted operator acknowledgement only. Never reset subscription statistics.
BEGIN;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR current_setting('server_version_num')::int NOT BETWEEN 160000 AND 169999
 OR current_user<>'postgres'
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE singleton AND schema_version=1 AND store_kind='logical_public_core')
 OR to_regclass('analytics_meta.admission_control') IS NULL
 THEN RAISE EXCEPTION 'Dedicated PG16 postgres operator required'; END IF;
END$$;

CREATE TABLE analytics_meta.replication_recovery_events (
 event_id text PRIMARY KEY CHECK(event_id ~ '^[0-9a-f]{64}$'),
 subid oid NOT NULL,
 stats_reset timestamptz,
 apply_errors bigint NOT NULL CHECK(apply_errors>=0),
 sync_errors bigint NOT NULL CHECK(sync_errors=0),
 source_generation uuid NOT NULL,
 source_system_identifier text NOT NULL CHECK(source_system_identifier ~ '^[0-9]{10,25}$'),
 source_timeline integer NOT NULL CHECK(source_timeline>0),
 origin_name text NOT NULL CHECK(origin_name='pg_'||subid::text),
 event_at timestamptz NOT NULL,
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND pg_column_size(evidence)<=16384),
 UNIQUE(subid,event_id)
);
CREATE TABLE analytics_meta.replication_recovery_ack (
 subid oid PRIMARY KEY,
 event_id text NOT NULL UNIQUE,
 FOREIGN KEY(subid,event_id) REFERENCES analytics_meta.replication_recovery_events(subid,event_id)
);
CREATE FUNCTION analytics_meta.reject_recovery_history_change() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN
 RAISE EXCEPTION 'Replication recovery history is append-only';
END$$;
CREATE TRIGGER replication_recovery_history_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON analytics_meta.replication_recovery_events FOR EACH STATEMENT
 EXECUTE FUNCTION analytics_meta.reject_recovery_history_change();

CREATE FUNCTION analytics_meta.replication_errors_acknowledged() RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT coalesce(
  (SELECT count(*)=1 FROM pg_catalog.pg_subscription)
  AND (SELECT count(*)=1 FROM pg_catalog.pg_stat_subscription_stats)
  AND (SELECT count(*)<=1 FROM analytics_meta.replication_recovery_ack)
  AND EXISTS(
   SELECT FROM pg_catalog.pg_subscription sub
   JOIN pg_catalog.pg_stat_subscription_stats stats ON stats.subid=sub.oid
   LEFT JOIN analytics_meta.replication_recovery_ack ack ON ack.subid=sub.oid
   LEFT JOIN analytics_meta.replication_recovery_events event ON event.subid=ack.subid AND event.event_id=ack.event_id
   WHERE sub.subname='ask_public_core_v1' AND sub.subdisableonerr AND NOT sub.subrunasowner
   AND stats.sync_error_count=0
   AND CASE WHEN ack.subid IS NULL THEN
    stats.apply_error_count=0 AND NOT EXISTS(SELECT FROM analytics_meta.replication_recovery_ack)
   ELSE
    stats.stats_reset IS NOT DISTINCT FROM event.stats_reset
    AND stats.apply_error_count=event.apply_errors AND stats.sync_error_count=event.sync_errors
    AND EXISTS(SELECT FROM analytics_meta.sync_state state
     JOIN analytics_meta.admission_control control USING(singleton)
     JOIN analytics_feed_meta.signal signal USING(singleton)
     WHERE state.singleton AND control.baseline_verified
     AND state.state<>'quarantined'
     AND state.source_id=event.source_generation AND signal.generation=event.source_generation
     AND state.source_system_identifier=event.source_system_identifier AND signal.system_identifier=event.source_system_identifier
     AND control.expected_timeline=event.source_timeline AND signal.timeline=event.source_timeline)
    AND EXISTS(SELECT FROM pg_catalog.pg_replication_origin_status origin WHERE origin.external_id=event.origin_name)
   END
  ),false)
$$;
ALTER TABLE analytics_meta.replication_recovery_events OWNER TO postgres;
ALTER TABLE analytics_meta.replication_recovery_ack OWNER TO postgres;
ALTER FUNCTION analytics_meta.replication_errors_acknowledged() OWNER TO postgres;
ALTER FUNCTION analytics_meta.reject_recovery_history_change() OWNER TO postgres;
REVOKE ALL ON analytics_meta.replication_recovery_events,analytics_meta.replication_recovery_ack FROM PUBLIC,analytics_owner,ask_public_reader,ask_public_view_owner;
REVOKE ALL ON FUNCTION analytics_meta.replication_errors_acknowledged(),analytics_meta.reject_recovery_history_change() FROM PUBLIC,analytics_owner,ask_public_reader,ask_public_view_owner;
COMMIT;
