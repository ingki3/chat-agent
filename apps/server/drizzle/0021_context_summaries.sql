CREATE TABLE `conversation_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`through_message_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`covered_hash` text NOT NULL,
	`summary` text NOT NULL,
	`runtime` text NOT NULL,
	`model` text NOT NULL,
	`run_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_summaries_conversation_idx` ON `conversation_summaries` (`conversation_id`,`through_seq`);--> statement-breakpoint
ALTER TABLE `runs` ADD `summary_divider_id` text;--> statement-breakpoint
ALTER TABLE `runtime_sessions` ADD `model` text;--> statement-breakpoint
ALTER TABLE `runtime_sessions` ADD `summary_id` text;--> statement-breakpoint
ALTER TABLE `runtime_sessions` ADD `trimmed` integer DEFAULT false NOT NULL;