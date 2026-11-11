CREATE TABLE `artifact_versions` (
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`language` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`run_id` text,
	`reverted_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`artifact_id`, `version`),
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`run_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`language` text,
	`latest_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifacts_conversation_idx` ON `artifacts` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `artifact_versions_immutable` BEFORE UPDATE ON `artifact_versions` BEGIN SELECT RAISE(ABORT, 'artifact versions are immutable'); END;