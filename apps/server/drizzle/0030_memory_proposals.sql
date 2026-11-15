CREATE TABLE `memory_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`apply_mode` text DEFAULT 'review' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_proposal_decisions` (
	`proposal_id` text NOT NULL,
	`idx` integer NOT NULL,
	`doc` text NOT NULL,
	`action` text NOT NULL,
	`item_id` text,
	`text` text,
	`before` text,
	`sources` text NOT NULL,
	`target_sources` text DEFAULT '[]' NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`proposal_id`, `idx`),
	FOREIGN KEY (`proposal_id`) REFERENCES `memory_proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`mode` text NOT NULL,
	`forced` text,
	`base` text NOT NULL,
	`applied` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_proposals_conversation_idx` ON `memory_proposals` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `memory_proposals_owner_idx` ON `memory_proposals` (`owner_id`);