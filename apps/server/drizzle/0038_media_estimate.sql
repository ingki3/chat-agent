ALTER TABLE `usage_records` ADD `estimated_cost_micros` integer;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `media_generation_id` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `media_settlement` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `media_settle_tries` integer;