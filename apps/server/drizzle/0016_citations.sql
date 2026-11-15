CREATE TABLE `citations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`n` integer NOT NULL,
	`source_id` text,
	`status` text NOT NULL,
	`snippet` text NOT NULL,
	`snippet_key` text NOT NULL,
	`quote` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `citations_run_n_idx` ON `citations` (`run_id`,`n`);