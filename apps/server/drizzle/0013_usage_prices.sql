CREATE TABLE `price_tables` (
	`version` integer PRIMARY KEY NOT NULL,
	`prices` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `usage_records` ADD `auth_type` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `price_version` integer;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `priced_cost_usd` real;