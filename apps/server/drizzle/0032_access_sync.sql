CREATE TABLE `access_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`reasons` text NOT NULL,
	`mode` text,
	`base_revision` text,
	`final_emails` text,
	`added` text,
	`removed` text,
	`error_code` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`confirmed_by` text,
	`write_sent` integer DEFAULT false NOT NULL,
	`revokes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE INDEX `access_syncs_status_idx` ON `access_syncs` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `admin_email_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`old_email` text NOT NULL,
	`new_email` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`switched_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `admin_email_changes_state_idx` ON `admin_email_changes` (`state`);