CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`run_key` text NOT NULL,
	`trigger` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`outcome` text,
	`error_code` text,
	`output_ref` text,
	`result_ref` text,
	`result_saved_at` integer,
	`notified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_runs_key_idx` ON `schedule_runs` (`run_key`);--> statement-breakpoint
CREATE INDEX `schedule_runs_schedule_idx` ON `schedule_runs` (`schedule_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `schedule_runs_status_idx` ON `schedule_runs` (`status`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`type` text NOT NULL,
	`date` text,
	`time` text,
	`weekdays` text,
	`cron` text,
	`time_zone` text DEFAULT 'Asia/Seoul' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`runtime` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`use_shared` integer DEFAULT false NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`conversation_id` text,
	`next_run_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `schedules_owner_idx` ON `schedules` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `schedules_next_run_idx` ON `schedules` (`next_run_at`);