-- Conservative rollback: deploy the previous backend and retain additive
-- indexes/foreign keys. This script intentionally removes no schema or data.
SELECT 'Additive phase-2 objects remain backward-compatible' AS rollback_status;
