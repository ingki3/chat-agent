CREATE TABLE `price_tables` (
	`version` integer PRIMARY KEY NOT NULL,
	`prices` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `usage_records` ADD `auth_type` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `price_version` integer;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `priced_cost_micros` integer;--> statement-breakpoint
-- Backfill (#32 review): rows from before this migration take the auth type of their connection, which is kept
-- after a disconnect. No price is applied to them (price_version stays NULL): an API key row shows as 미제공.
UPDATE `usage_records` SET `auth_type` = (SELECT `c`.`auth_type` FROM `connections` `c` WHERE `c`.`id` = `usage_records`.`connection_id`) WHERE `connection_id` IS NOT NULL;--> statement-breakpoint
-- A connection that cannot be found any more: explicitly unknown (counted as 미제공), never dropped.
UPDATE `usage_records` SET `auth_type` = 'unknown' WHERE `connection_id` IS NOT NULL AND `auth_type` IS NULL;
