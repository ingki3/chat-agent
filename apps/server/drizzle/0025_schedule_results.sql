CREATE TABLE `schedule_attempts` (
	`schedule_run_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`conversation_id` text NOT NULL,
	`user_message_id` text,
	`assistant_message_id` text NOT NULL,
	`chat_run_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`schedule_run_id`, `attempt`),
	FOREIGN KEY (`schedule_run_id`) REFERENCES `schedule_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schedule_results` (
	`schedule_run_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`schedule_run_id`) REFERENCES `schedule_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `new_result_at` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `new_result_message_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_idx` ON `notifications` (`dedupe_key`);