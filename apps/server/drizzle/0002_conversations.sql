CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`title_source` text DEFAULT 'auto' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`kind` text DEFAULT 'normal' NOT NULL,
	`forked_from` text,
	`last_runtime` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_owner_updated_idx` ON `conversations` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`runtime` text,
	`model` text,
	`effort` text,
	`connection_id` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`revision` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`replaces` text,
	`superseded_by` text,
	`archived_at_revision` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_seq_idx` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_conversation_active_idx` ON `messages` (`conversation_id`,`active`,`seq`);--> statement-breakpoint
CREATE TABLE `runtime_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`runtime` text NOT NULL,
	`connection_id` text,
	`external_session_id` text NOT NULL,
	`last_message_id` text,
	`conversation_revision` integer NOT NULL,
	`invalidated` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runtime_sessions_conversation_idx` ON `runtime_sessions` (`conversation_id`);