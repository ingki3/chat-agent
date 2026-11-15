CREATE TABLE `run_events` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_message_id` text,
	`assistant_message_id` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`runtime` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`idempotency_key` text,
	`next_event_seq` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_conversation_idx` ON `runs` (`conversation_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_user_idempotency_idx` ON `runs` (`user_id`,`idempotency_key`);