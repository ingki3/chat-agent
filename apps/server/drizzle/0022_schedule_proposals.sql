CREATE TABLE `schedule_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`timing` text NOT NULL,
	`time_zone` text NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`schedule_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `schedule_proposals_conversation_idx` ON `schedule_proposals` (`conversation_id`);