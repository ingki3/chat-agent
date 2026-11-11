CREATE TABLE `finance_results` (
	`message_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `finance_results_conversation_idx` ON `finance_results` (`conversation_id`);