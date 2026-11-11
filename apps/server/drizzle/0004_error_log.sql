CREATE TABLE `error_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`code` text NOT NULL,
	`category` text NOT NULL,
	`user_id` text,
	`conversation_id` text,
	`run_id` text,
	`runtime` text,
	`tool` text,
	`route` text,
	`status_code` integer
);
--> statement-breakpoint
CREATE INDEX `error_log_at_idx` ON `error_log` (`at`);