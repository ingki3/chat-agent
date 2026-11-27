CREATE TABLE `compose_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`message_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`timeline_json` text NOT NULL,
	`plan_json` text,
	`duration_ms` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`clips` integer NOT NULL,
	`subtitles` integer NOT NULL,
	`progress` integer,
	`file_id` text,
	`error_code` text,
	`version` integer DEFAULT 0 NOT NULL,
	`boot` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`notified_at` integer,
	`notify_next_at` integer,
	`notify_tries` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `compose_jobs_conversation_idx` ON `compose_jobs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `compose_jobs_status_idx` ON `compose_jobs` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `compose_done` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `compose_failed` integer DEFAULT true NOT NULL;