CREATE TABLE `share_snapshots` (
	`share_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`digest` text,
	PRIMARY KEY(`share_id`, `item_type`, `item_id`, `revision`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `share_targets` (
	`share_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`share_id`, `user_id`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_targets_user_idx` ON `share_targets` (`user_id`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`item_kind` text NOT NULL,
	`item_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`audience` text NOT NULL,
	`mode` text NOT NULL,
	`boundary_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shares_item_idx` ON `shares` (`item_kind`,`item_id`);--> statement-breakpoint
CREATE INDEX `shares_conversation_idx` ON `shares` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `shares_owner_idx` ON `shares` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `share_snapshots_immutable` BEFORE UPDATE ON `share_snapshots` BEGIN SELECT RAISE(ABORT, 'share snapshots are immutable'); END;
