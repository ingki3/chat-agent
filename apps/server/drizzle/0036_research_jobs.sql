CREATE TABLE `research_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`message_id` text NOT NULL,
	`status` text NOT NULL,
	`backend` text DEFAULT 'claude' NOT NULL,
	`question` text NOT NULL,
	`file_ids` text DEFAULT '[]' NOT NULL,
	`clarify_question` text,
	`clarify_answer` text,
	`plan` text,
	`state` text DEFAULT '{}' NOT NULL,
	`result` text,
	`error_code` text,
	`active_ms` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	`deadline_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_jobs_conversation_idx` ON `research_jobs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `research_jobs_owner_status_idx` ON `research_jobs` (`owner_id`,`status`);--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `research_done` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `research_failed` integer DEFAULT true NOT NULL;