CREATE TABLE `usage_records` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`run_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`runtime` text NOT NULL,
	`model` text NOT NULL,
	`connection_id` text,
	`purpose` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`cost_usd` real,
	`request_count` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_run_attempt_idx` ON `usage_records` (`run_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `usage_records_user_created_idx` ON `usage_records` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_records_created_idx` ON `usage_records` (`created_at`);