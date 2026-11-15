CREATE TABLE `dreaming_days` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`trigger` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`next_at` integer NOT NULL,
	`deferrals` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dreaming_days_next_idx` ON `dreaming_days` (`state`,`next_at`);--> statement-breakpoint
CREATE TABLE `dreaming_prompts` (
	`version` integer PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`author_id` text,
	`restored_from` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dreaming_queue` (
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`doc` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `message_id`, `doc`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dreaming_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`attempt` integer NOT NULL,
	`idem_key` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`code` text,
	`counts` text NOT NULL,
	`runtime` text,
	`model` text,
	`connection_id` text,
	`prompt_version` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dreaming_runs_idem_idx` ON `dreaming_runs` (`idem_key`);--> statement-breakpoint
CREATE INDEX `dreaming_runs_user_idx` ON `dreaming_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `dreaming_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`checkpoint` integer DEFAULT 0 NOT NULL,
	`checkpoint_at` integer,
	`paused_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_message_seq` (
	`message_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_message_seq_user_idx` ON `memory_message_seq` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `memory_seq_counters` (
	`user_id` text PRIMARY KEY NOT NULL,
	`last` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `__new_memory_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`conversation_id` text,
	`run_id` text NOT NULL,
	`origin` text DEFAULT 'tool' NOT NULL,
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
INSERT INTO `__new_memory_proposals`("id", "owner_id", "conversation_id", "run_id", "origin", "mode", "forced", "base", "applied", "created_at", "updated_at") SELECT "id", "owner_id", "conversation_id", "run_id", 'tool', "mode", "forced", "base", "applied", "created_at", "updated_at" FROM `memory_proposals`;--> statement-breakpoint
CREATE TABLE `__new_memory_proposal_decisions` (
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
	`merge_ids` text,
	PRIMARY KEY(`proposal_id`, `idx`),
	FOREIGN KEY (`proposal_id`) REFERENCES `__new_memory_proposals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_memory_proposal_decisions`("proposal_id", "idx", "doc", "action", "item_id", "text", "before", "sources", "target_sources", "sensitive", "status", "updated_at", "merge_ids") SELECT "proposal_id", "idx", "doc", "action", "item_id", "text", "before", "sources", "target_sources", "sensitive", "status", "updated_at", NULL FROM `memory_proposal_decisions`;--> statement-breakpoint
DROP TABLE `memory_proposal_decisions`;--> statement-breakpoint
DROP TABLE `memory_proposals`;--> statement-breakpoint
ALTER TABLE `__new_memory_proposals` RENAME TO `memory_proposals`;--> statement-breakpoint
ALTER TABLE `__new_memory_proposal_decisions` RENAME TO `memory_proposal_decisions`;--> statement-breakpoint
CREATE INDEX `memory_proposals_conversation_idx` ON `memory_proposals` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `memory_proposals_owner_idx` ON `memory_proposals` (`owner_id`);--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `memory_proposals` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `memory_applied` integer DEFAULT true NOT NULL;--> statement-breakpoint
INSERT INTO `memory_message_seq` (`message_id`, `user_id`, `seq`, `created_at`) SELECT m.`id`, c.`owner_id`, ROW_NUMBER() OVER (PARTITION BY c.`owner_id` ORDER BY m.`created_at`, m.`conversation_id`, m.`seq`), m.`created_at` FROM `messages` m JOIN `conversations` c ON c.`id` = m.`conversation_id` WHERE m.`role` = 'user' AND m.`active` = 1;--> statement-breakpoint
INSERT INTO `memory_seq_counters` (`user_id`, `last`) SELECT `user_id`, MAX(`seq`) FROM `memory_message_seq` GROUP BY `user_id`;--> statement-breakpoint
CREATE TRIGGER `messages_memory_seq` AFTER INSERT ON `messages` WHEN NEW.`role` = 'user' AND NEW.`active` = 1 BEGIN INSERT OR IGNORE INTO `memory_seq_counters` (`user_id`, `last`) SELECT `owner_id`, 0 FROM `conversations` WHERE `id` = NEW.`conversation_id`; UPDATE `memory_seq_counters` SET `last` = `last` + 1 WHERE `user_id` = (SELECT `owner_id` FROM `conversations` WHERE `id` = NEW.`conversation_id`); INSERT INTO `memory_message_seq` (`message_id`, `user_id`, `seq`, `created_at`) SELECT NEW.`id`, k.`user_id`, k.`last`, NEW.`created_at` FROM `memory_seq_counters` k WHERE k.`user_id` = (SELECT `owner_id` FROM `conversations` WHERE `id` = NEW.`conversation_id`); END;
