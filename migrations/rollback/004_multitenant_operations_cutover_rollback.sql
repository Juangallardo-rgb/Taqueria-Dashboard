-- Conservative cutover rollback.
-- Once two restaurants can share external IDs, restoring global uniqueness may
-- be impossible without deleting data. Do not attempt a destructive SQL rollback.
-- Roll back only to a previously tested multi-tenant backend or restore a full
-- pre-cutover database snapshot under an approved incident procedure.
SELECT 'No automatic destructive rollback is safe after multi-tenant cutover' AS rollback_status;
