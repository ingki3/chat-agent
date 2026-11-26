CREATE TABLE `video_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`message_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text NOT NULL,
	`duration_sec` integer NOT NULL,
	`resolution` text NOT NULL,
	`aspect_ratio` text,
	`audio` integer,
	`estimate_micros` integer NOT NULL,
	`cost_micros` integer,
	`settings_revision` text NOT NULL,
	`key_mark` text NOT NULL,
	`usage_key` text,
	`remote_id` text,
	`file_id` text,
	`error_code` text,
	`progress` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_at` integer,
	`submitted_at` integer,
	`deadline_at` integer,
	`next_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`ended_at` integer,
	`notified_at` integer,
	`notify_next_at` integer,
	`notify_tries` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `video_jobs_conversation_idx` ON `video_jobs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `video_jobs_status_idx` ON `video_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `video_jobs_next_idx` ON `video_jobs` (`status`,`next_at`);--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `video_done` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `video_failed` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TRIGGER `video_jobs_prompt_changed` AFTER UPDATE OF `prompt` ON `video_jobs` WHEN OLD.`prompt` IS NOT NEW.`prompt` AND NEW.`status` = 'awaiting_approval' BEGIN UPDATE `video_jobs` SET `status` = 'failed', `error_code` = 'video_blocked', `ended_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000, `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000, `version` = `version` + 1 WHERE `id` = NEW.`id`; END;
