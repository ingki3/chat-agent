CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	`auth_type` text NOT NULL,
	`scope` text NOT NULL,
	`owner_id` text,
	`created_by` text,
	`label` text NOT NULL,
	`secret` text,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`hint` text,
	`status` text DEFAULT 'untested' NOT NULL,
	`last_test_at` integer,
	`last_test_code` text,
	`disconnected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connections_owner_idx` ON `connections` (`owner_id`);--> statement-breakpoint
CREATE INDEX `connections_scope_runtime_idx` ON `connections` (`scope`,`runtime`);--> statement-breakpoint
CREATE TABLE `runtime_policies` (
	`user_id` text NOT NULL,
	`runtime` text NOT NULL,
	`allowed` integer DEFAULT true NOT NULL,
	`models` text DEFAULT '"all"' NOT NULL,
	`efforts` text DEFAULT '"all"' NOT NULL,
	`allow_personal` integer DEFAULT true NOT NULL,
	`allow_shared` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `runtime`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `connection_version` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `use_shared` integer DEFAULT false NOT NULL;