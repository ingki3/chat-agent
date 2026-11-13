CREATE TABLE `fork_items` (
	`fork_id` text NOT NULL,
	`item_type` text NOT NULL,
	`source_id` text NOT NULL,
	`copy_id` text NOT NULL,
	PRIMARY KEY(`fork_id`, `item_type`, `source_id`),
	FOREIGN KEY (`fork_id`) REFERENCES `forks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fork_items_source_idx` ON `fork_items` (`item_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `forks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`share_id` text NOT NULL,
	`source_conversation_id` text NOT NULL,
	`source_item_kind` text NOT NULL,
	`source_item_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forks_conversation_idx` ON `forks` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `forks_source_idx` ON `forks` (`source_conversation_id`);--> statement-breakpoint
CREATE TABLE `share_subscriptions` (
	`share_id` text NOT NULL,
	`user_id` text NOT NULL,
	`notify_results` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `user_id`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `share_views` (
	`share_id` text NOT NULL,
	`user_id` text NOT NULL,
	`first_viewed_at` integer NOT NULL,
	`last_viewed_at` integer NOT NULL,
	PRIMARY KEY(`share_id`, `user_id`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_views_user_idx` ON `share_views` (`user_id`);