CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`url` text NOT NULL,
	`final_url` text,
	`title` text NOT NULL,
	`site` text NOT NULL,
	`published_at` text,
	`fetched_at` integer NOT NULL,
	`content_type` text,
	`body_hash` text,
	`body` text,
	`truncated` integer DEFAULT false NOT NULL,
	`snippet` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sources_conversation_idx` ON `sources` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sources_conversation_url_idx` ON `sources` (`conversation_id`,`url`);