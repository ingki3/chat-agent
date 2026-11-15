CREATE TABLE `memory_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`kind` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_documents_owner_kind_idx` ON `memory_documents` (`owner_id`,`kind`);--> statement-breakpoint
CREATE TABLE `memory_item_sources` (
	`item_id` text NOT NULL,
	`message_id` text NOT NULL,
	`revision` integer NOT NULL,
	`conversation_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `message_id`),
	FOREIGN KEY (`item_id`) REFERENCES `memory_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_item_sources_message_idx` ON `memory_item_sources` (`message_id`);--> statement-breakpoint
CREATE INDEX `memory_item_sources_conversation_idx` ON `memory_item_sources` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `memory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `memory_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_items_document_idx` ON `memory_items` (`document_id`);--> statement-breakpoint
CREATE TABLE `memory_versions` (
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`author` text NOT NULL,
	`actor_id` text,
	`prev_version` integer,
	`restored_from` integer,
	`content` text NOT NULL,
	`item_ids` text,
	`unlinked_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `version`),
	FOREIGN KEY (`document_id`) REFERENCES `memory_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `runtime_sessions` ADD `doc_versions` text;