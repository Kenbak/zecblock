-- Rollback for replication-recovery-v2.sql: restores the v1 strict body.
-- A store that is quarantined or baseline-pending with an acknowledged epoch
-- then needs the manual baseline in feed-recovery.md again.
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
CREATE OR REPLACE FUNCTION analytics_meta.replication_errors_acknowledged() RETURNS boolean
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
DROP FUNCTION analytics_meta.replication_errors_acknowledged(boolean);
COMMIT;
